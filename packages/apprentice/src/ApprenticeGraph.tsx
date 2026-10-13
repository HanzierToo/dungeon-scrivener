import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, ControlButton, Controls, MarkerType, NodeResizer, ReactFlow, SelectionMode, type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { resolveNodeActions, type TextSource, type WorldDocument } from '@dungeon-scrivener/model';
import { applyGraphCommand, previewGraphDeletion, type GraphCommand } from './commands.js';
import { RouteEdge } from './RouteEdge.js';
import { projectGraph } from './graph.js';
import { emptyGraphLayout, moveNodeToSection, sectionAtPoint, type GraphLayout, type GraphPositions, type GraphSection } from './layout.js';

export interface ApprenticeGraphProps {
  readonly world: WorldDocument;
  readonly layout?: GraphLayout;
  readonly onLayoutChange?: (layout: GraphLayout) => void;
  readonly nodeLabels?: Readonly<Record<string, string>>;
  readonly localeStrings?: Readonly<Record<string, string>>;
  readonly selectedNodeId?: string;
  readonly onSelectNode?: (nodeId: string | undefined) => void;
  readonly onOpenActions?: (nodeId: string, action?: { kind: 'choice' | 'command'; id: string; outcomeId?: string | undefined }) => void;
  readonly onWorldChange?: (world: WorldDocument) => void;
}

export type { GraphPositions } from './layout.js';

const defaultPosition = (index: number) => ({ x: 0, y: index * 180 });
const newId = (kind: 'scene' | 'folder' | 'link') => `${kind}-${crypto.randomUUID().replaceAll('-', '')}`;
type MapState = { world: WorldDocument; layout: GraphLayout };
type Selection = { nodes: readonly string[]; edges: readonly string[]; sections: readonly string[] };
type MenuTarget = { kind: 'pane' | 'node' | 'edge' | 'section' | 'selection'; id?: string; x: number; y: number; point: { x: number; y: number } };
type PendingConnection = { sourceId: string; targetId: string; x: number; y: number };
const emptySelection = (): Selection => ({ nodes: [], edges: [], sections: [] });
const sectionId = (id: string) => `section:${id}`;

function SectionCard({ id, data, selected }: NodeProps) {
  const section = data['section'] as GraphSection;
  const sceneCount = data['sceneCount'] as number;
  const crossingRoutes = data['crossingRoutes'] as number;
  const toggle = data['toggle'] as (id: string) => void;
  const choose = data['choose'] as (id: string, event: React.MouseEvent) => void;
  const resize = data['resize'] as (id: string, bounds: { x: number; y: number; width: number; height: number }) => void;
  return <div className={`apprentice-section-card${selected ? ' is-selected' : ''}${section.collapsed ? ' is-collapsed' : ''}`}>
    {!section.collapsed && <NodeResizer minWidth={240} minHeight={140} isVisible={selected} onResizeEnd={(_event, bounds) => resize(section.id, bounds)} />}
    {!section.collapsed && <div className="apprentice-section-border" aria-hidden="true">{(['top', 'right', 'bottom', 'left'] as const).map(side => <span key={side} className={`apprentice-section-border--${side}`} onClick={event => choose(section.id, event)} />)}</div>}
    <div className="apprentice-section-header" onClick={event => choose(section.id, event)}>
      <button className="nodrag" type="button" aria-label={`${section.collapsed ? 'Expand' : 'Collapse'} section ${section.title}`} onClick={event => { event.stopPropagation(); toggle(section.id); }}>{section.collapsed ? '▸' : '▾'}</button>
      <strong>{section.title}</strong><span>{sceneCount} scenes{section.collapsed ? ` · ${crossingRoutes} crossing routes` : ''}</span>
    </div>
  </div>;
}
const nodeTypes = { section: SectionCard };
const edgeTypes = { route: RouteEdge };

/** World edits use structured commands; map coordinates are separate authoring metadata. */
export function ApprenticeGraph({ world, layout = emptyGraphLayout(), onLayoutChange, nodeLabels, localeStrings, selectedNodeId, onSelectNode, onOpenActions, onWorldChange }: ApprenticeGraphProps) {
  const [current, setCurrent] = useState<MapState>(() => ({ world, layout }));
  const currentRef = useRef(current);
  const [draftLayout, setDraftLayout] = useState(layout);
  const draftRef = useRef(layout);
  const [past, setPast] = useState<readonly MapState[]>([]);
  const [future, setFuture] = useState<readonly MapState[]>([]);
  const [selection, setSelection] = useState<Selection>(() => ({ nodes: selectedNodeId ? [selectedNodeId] : [], edges: [], sections: [] }));
  const [panTool, setPanTool] = useState(false);
  const [modifierPan, setModifierPan] = useState(false);
  const [nodeMeasurements, setNodeMeasurements] = useState<Readonly<Record<string, { width: number; height: number }>>>({});
  const [message, setMessage] = useState('');
  const [nodeQuery, setNodeQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<MenuTarget | null>(null);
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  const [editingAction, setEditingAction] = useState<{ nodeId: string; kind: 'choice' | 'command'; id: string } | null>(null);
  const [actionText, setActionText] = useState('');
  const [actionDestination, setActionDestination] = useState('');
  const [editingRoute, setEditingRoute] = useState<string | null>(null);
  const [routeDestination, setRouteDestination] = useState('');
  const reconnectSucceeded = useRef(false);
  const [routeActionKind, setRouteActionKind] = useState<'choice' | 'command' | 'existing' | 'route-only'>('choice');
  const [routeExistingAction, setRouteExistingAction] = useState('');
  const [routeActionText, setRouteActionText] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const toolsDetailsRef = useRef<HTMLDetailsElement>(null);
  const routeTextRef = useRef<HTMLInputElement>(null);
  const lastRequestedNodeId = useRef<string | null | undefined>(null);
  const selectionAtPointerDown = useRef<Selection | null>(null);
  const lastEmittedWorld = useRef<WorldDocument | null>(null);
  const lastEmittedLayout = useRef('');
  const graphElement = useRef<HTMLElement>(null);
  const flowInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  useEffect(() => {
    const update = (event: KeyboardEvent) => setModifierPan(event.shiftKey || event.metaKey || event.ctrlKey);
    const clear = () => setModifierPan(false);
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', clear);
    return () => { window.removeEventListener('keydown', update); window.removeEventListener('keyup', update); window.removeEventListener('blur', clear); };
  }, []);
  useEffect(() => {
    if (world === lastEmittedWorld.current) { lastEmittedWorld.current = null; return; }
    if (world === currentRef.current.world) return;
    const next = { ...currentRef.current, world };
    currentRef.current = next;
    setCurrent(next);
    setPast([]);
    setFuture([]);
  }, [world]);
  useEffect(() => {
    const serialized = JSON.stringify(layout);
    if (serialized === lastEmittedLayout.current) { lastEmittedLayout.current = ''; return; }
    if (serialized === JSON.stringify(currentRef.current.layout)) return;
    const next = { ...currentRef.current, layout };
    currentRef.current = next;
    draftRef.current = layout;
    setCurrent(next);
    setDraftLayout(layout);
    setPast([]);
    setFuture([]);
  }, [layout]);
  useEffect(() => {
    if (selectedNodeId === lastRequestedNodeId.current) { lastRequestedNodeId.current = null; return; }
    if (!selectedNodeId || selection.nodes.includes(selectedNodeId)) return;
    setSelection({ nodes: [selectedNodeId], edges: [], sections: [] });
  }, [selectedNodeId]);
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu || !contextMenu) return;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(contextMenu.x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(contextMenu.y, window.innerHeight - rect.height - 8))}px`;
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as globalThis.Node)) setContextMenu(null); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [contextMenu]);
  useEffect(() => { if (pendingConnection) routeTextRef.current?.focus(); }, [pendingConnection]);
  const editableWorld = current.world;
  const graph = useMemo(() => projectGraph(editableWorld), [editableWorld]);
  const labelText = (value: TextSource) => value.kind === 'literal' ? value.text : localeStrings?.[value.key] ?? value.key;
  const effectiveActions = useMemo(() => new Map(editableWorld.nodes.filter(node => node.visitable).map(node => [node.id, resolveNodeActions(editableWorld, node.id).value])), [editableWorld]);
  const routeActionLabels = new Map<string, string[]>();
  for (const edge of editableWorld.navigationEdges) {
    const actions = effectiveActions.get(edge.fromNodeId);
    const labels = [...(actions?.choices ?? []).flatMap(choice => [
      ...(choice.navigationEdgeId === edge.id ? [labelText(choice.label)] : []),
      ...(choice.outcomes ?? []).filter(outcome => outcome.navigationEdgeId === edge.id).map(outcome => `${labelText(choice.label)}: ${outcome.name}`),
    ]), ...(actions?.commands ?? []).flatMap(command => [
      ...(command.navigationEdgeId === edge.id ? [`⌨ ${command.patterns[0] ?? 'Command'}`] : []),
      ...(command.outcomes ?? []).filter(outcome => outcome.navigationEdgeId === edge.id).map(outcome => `⌨ ${command.patterns[0] ?? 'Command'}: ${outcome.name}`),
    ])];
    if (labels.length) routeActionLabels.set(edge.id, labels);
  }
  const selectedNodes = new Set(selection.nodes);
  const selectedEdges = new Set(selection.edges);
  const selectionCount = selection.nodes.length + selection.edges.length + selection.sections.length;
  const hiddenNodes = new Set(draftLayout.sections.filter(section => section.collapsed).flatMap(section => section.nodeIds));
  const matchingNodes = useMemo(() => nodeQuery.trim() ? graph.nodes.filter(node =>
    `${nodeLabels?.[node.id] ?? node.title} ${node.id}`.toLocaleLowerCase().includes(nodeQuery.trim().toLocaleLowerCase())) : [], [graph.nodes, nodeLabels, nodeQuery]);
  const setDraft = (next: GraphLayout) => { draftRef.current = next; setDraftLayout(next); };
  const publish = (next: MapState, record = true) => {
    const previous = currentRef.current;
    if (next.world === previous.world && JSON.stringify(next.layout) === JSON.stringify(previous.layout)) return;
    if (record) { setPast(items => [...items, previous]); setFuture([]); }
    currentRef.current = next;
    setCurrent(next);
    setDraft(next.layout);
    if (next.world !== previous.world) { lastEmittedWorld.current = next.world; onWorldChange?.(next.world); }
    if (JSON.stringify(next.layout) !== JSON.stringify(previous.layout)) { lastEmittedLayout.current = JSON.stringify(next.layout); onLayoutChange?.(next.layout); }
    setMessage('');
  };
  const commitLayout = (next: GraphLayout) => publish({ ...currentRef.current, layout: next });
  const dispatch = (command: GraphCommand) => {
    const result = applyGraphCommand(currentRef.current.world, command);
    if (result.ok) publish({ ...currentRef.current, world: result.world });
    else setMessage(result.message);
    return result.ok;
  };
  const undo = () => {
    const previous = past.at(-1);
    if (!previous) return;
    const undone = currentRef.current;
    setPast(items => items.slice(0, -1));
    setFuture(items => [undone, ...items]);
    publish(previous, false);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    const redoneFrom = currentRef.current;
    setFuture(items => items.slice(1));
    setPast(items => [...items, redoneFrom]);
    publish(next, false);
  };
  const notifySelectNode = (id: string | undefined) => { lastRequestedNodeId.current = id; onSelectNode?.(id); };
  const openRouteAction = (edgeId: string) => {
    const edge = editableWorld.navigationEdges.find(item => item.id === edgeId);
    if (!edge) return;
    const actions = effectiveActions.get(edge.fromNodeId);
    const choice = actions?.choices.find(action => action.navigationEdgeId === edgeId || action.outcomes?.some(outcome => outcome.navigationEdgeId === edgeId));
    const command = actions?.commands.find(action => action.navigationEdgeId === edgeId || action.outcomes?.some(outcome => outcome.navigationEdgeId === edgeId));
    const outcomeId = (choice ?? command)?.outcomes?.find(outcome => outcome.navigationEdgeId === edgeId)?.id;
    lastRequestedNodeId.current = edge.fromNodeId;
    onOpenActions?.(edge.fromNodeId, choice ? { kind: 'choice', id: choice.id, outcomeId } : command ? { kind: 'command', id: command.id, outcomeId } : undefined);
  };
  const selectRoute = (edgeId: string) => { setSelection({ nodes: [], edges: [edgeId], sections: [] }); openRouteAction(edgeId); };
  const changeRouteCenter = (edgeId: string, point: { x: number; y: number } | null) => { const routeCenters = { ...currentRef.current.layout.routeCenters }; if (point) routeCenters[edgeId] = point; else delete routeCenters[edgeId]; commitLayout({ ...currentRef.current.layout, routeCenters }); };
  const selectNode = (id: string, additive = false) => {
    setSelection(previous => ({ nodes: additive ? previous.nodes.includes(id) ? previous.nodes.filter(item => item !== id) : [...previous.nodes, id] : [id], edges: additive ? previous.edges : [], sections: additive ? previous.sections : [] }));
    notifySelectNode(additive && selection.nodes.includes(id) && selection.nodes.length === 1 ? undefined : id);
  };
  const selectSection = (id: string, event: React.MouseEvent) => {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    setSelection(previous => ({ nodes: additive ? previous.nodes : [], edges: additive ? previous.edges : [], sections: additive ? previous.sections.includes(id) ? previous.sections.filter(item => item !== id) : [...previous.sections, id] : [id] }));
    graphElement.current?.focus();
  };
  const toggleSection = (id: string) => {
    const section = currentRef.current.layout.sections.find(item => item.id === id);
    if (!section) return;
    commitLayout({ ...currentRef.current.layout, sections: currentRef.current.layout.sections.map(item => item.id === id ? { ...item, collapsed: !item.collapsed } : item) });
    setSelection({ nodes: [], edges: [], sections: [id] });
  };
  const resizeSection = (id: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const layout = currentRef.current.layout;
    const section = layout.sections.find(item => item.id === id);
    if (!section) return;
    const memberRight = Math.max(0, ...section.nodeIds.map(nodeId => (layout.positions[nodeId]?.x ?? 0) + (nodeMeasurements[nodeId]?.width ?? 200) + 24 - bounds.x));
    const memberBottom = Math.max(0, ...section.nodeIds.map(nodeId => (layout.positions[nodeId]?.y ?? 0) + (nodeMeasurements[nodeId]?.height ?? 80) + 24 - bounds.y));
    commitLayout({ ...layout, sections: layout.sections.map(item => item.id === id ? { ...item, ...bounds, width: Math.max(240, bounds.width, memberRight), height: Math.max(140, bounds.height, memberBottom) } : item) });
  };
  const focusNode = (id: string) => {
    const index = graph.nodes.findIndex(node => node.id === id);
    const section = currentRef.current.layout.sections.find(item => item.collapsed && item.nodeIds.includes(id));
    if (section) toggleSection(section.id);
    const point = draftRef.current.positions[id] ?? defaultPosition(index);
    selectNode(id);
    setNodeQuery('');
    void flowInstance.current?.setCenter(point.x + 100, point.y + 40, { zoom: Math.max(flowInstance.current.getZoom(), 0.9), duration: 180 });
  };
  const nodes: Node[] = [...draftLayout.sections.map(section => ({
    id: sectionId(section.id), type: 'section', position: { x: section.x, y: section.y }, draggable: true,
    dragHandle: '.apprentice-section-header', selectable: false, selected: selection.sections.includes(section.id),
    data: { section, toggle: toggleSection, choose: selectSection, resize: resizeSection,
      sceneCount: section.nodeIds.filter(id => graph.nodes.find(node => node.id === id)?.visitable).length,
      crossingRoutes: graph.navigation.filter(edge => section.nodeIds.includes(edge.fromNodeId) !== section.nodeIds.includes(edge.toNodeId)).length },
    style: { width: section.width, height: section.collapsed ? 48 : section.height, zIndex: -1 },
    className: 'apprentice-section-node',
  } as Node)), ...graph.nodes.filter(node => !hiddenNodes.has(node.id)).map((node, index) => ({
    id: node.id,
    position: draftLayout.positions[node.id] ?? defaultPosition(index),
    ...(nodeMeasurements[node.id] ? { measured: nodeMeasurements[node.id] } : {}),
    data: { label: <><span>{node.visitable ? 'Scene' : 'Logic folder'}: {nodeLabels?.[node.id] ?? node.title}</span>{node.id === editableWorld.entryNodeId && <small className="apprentice-node-kind">Start scene</small>}{!node.visitable && <small className="apprentice-node-kind">Shares actions and rules</small>}{node.visitable && (() => {
      const actions = effectiveActions.get(node.id);
      const choices = actions?.choices ?? [];
      const commands = actions?.commands ?? [];
      const visible = [...choices.map(choice => ({ id: choice.id, text: labelText(choice.label), routeId: choice.navigationEdgeId, outcomeCount: choice.outcomes?.length ?? 0, kind: 'choice' as const })), ...commands.map(command => ({ id: command.id, text: command.patterns[0] ?? command.id, routeId: command.navigationEdgeId, outcomeCount: command.outcomes?.length ?? 0, kind: 'command' as const }))];
      return visible.length ? <div className="apprentice-node-actions" aria-label={`${visible.length} player actions`}>{visible.slice(0, 3).map(action => <button type="button" className="nodrag nopan apprentice-node-action" key={action.id} onClick={event => {
        event.stopPropagation();
        if (event.shiftKey || event.metaKey || event.ctrlKey) { selectNode(node.id, true); setEditingAction(null); return; }
        selectNode(node.id);
        onOpenActions?.(node.id, { kind: action.kind, id: action.id });
        setEditingRoute(null);
        setPendingConnection(null);
        setEditingAction({ nodeId: node.id, kind: action.kind, id: action.id });
        setActionText(action.text);
        setActionDestination(graph.navigation.find(edge => edge.id === action.routeId)?.toNodeId ?? '');
        setMessage('');
      }} title={action.text}><span className="apprentice-node-action-label">{action.kind === 'command' ? '⌨ ' : '↳ '}{action.text}</span>{action.outcomeCount ? <span> · {action.outcomeCount} conditional outcomes</span> : action.routeId ? <span> → {nodeLabels?.[graph.navigation.find(edge => edge.id === action.routeId)?.toNodeId ?? ''] ?? 'scene'}</span> : <span> · no direct destination</span>}</button>)}{visible.length > 3 && <button type="button" className="nodrag nopan" onClick={event => { event.stopPropagation(); lastRequestedNodeId.current = node.id; onOpenActions?.(node.id, visible[3]); }}>+{visible.length - 3} more actions</button>}</div> : <small className="apprentice-node-empty">No player actions</small>;
    })()}{selectedNodes.has(node.id) && <strong className="apprentice-node-selected">Selected</strong>}</> },
    selected: selectedNodes.has(node.id),
    connectable: true,
    className: node.visitable ? 'apprentice-scene-node' : 'apprentice-folder-node',
    style: { borderRadius: node.visitable ? 8 : 5, border: node.visitable ? '2px solid #365b78' : '2px dashed #a36b3f', padding: 12, width: 240, minWidth: 178 },
  }))];
  const edges: Edge[] = [
    ...graph.containment.filter(edge => !hiddenNodes.has(edge.parentId) && !hiddenNodes.has(edge.childId)).map((edge) => ({ id: edge.id, source: edge.parentId, target: edge.childId, label: 'contains', type: 'step', selected: selectedEdges.has(edge.id), reconnectable: false, style: { stroke: '#a36b3f', strokeWidth: 2.5, strokeDasharray: '6 5' }, labelStyle: { fill: '#7a4a2c', fontWeight: 700 } })),
    ...graph.navigation.filter(edge => !hiddenNodes.has(edge.fromNodeId) && !hiddenNodes.has(edge.toNodeId)).map((edge) => {
      const labels = routeActionLabels.get(edge.id) ?? [];
      const playable = labels.length > 0;
      return { id: edge.id, source: edge.fromNodeId, target: edge.toNodeId, ariaLabel: `Route from ${nodeLabels?.[edge.fromNodeId] ?? edge.fromNodeId} to ${nodeLabels?.[edge.toNodeId] ?? edge.toNodeId}${playable ? ` via ${labels.join(', ')}` : ' without choice or command'}`, type: 'route', data: { center: draftLayout.routeCenters?.[edge.id], onCenterChange: changeRouteCenter, onSelect: selectRoute, onContextMenu: (event: React.MouseEvent, id: string) => { selectRoute(id); openContextMenu(event, 'edge', id); } }, reconnectable: selection.edges.length === 1 && selectedEdges.has(edge.id) ? 'target' as const : false, selected: selectedEdges.has(edge.id), label: playable ? `${labels[0]!.slice(0, 36)}${labels[0]!.length > 36 ? '…' : ''}${labels.length > 1 ? ` +${labels.length - 1}` : ''}` : 'Advanced route only', markerEnd: { type: MarkerType.ArrowClosed, markerUnits: 'userSpaceOnUse', width: 24, height: 24, color: playable ? '#087b69' : '#a36b3f' }, style: { stroke: playable ? '#087b69' : '#a36b3f', strokeWidth: 3.5, ...(playable ? {} : { strokeDasharray: '7 5' }) } };
    }),
  ];

  const onNodesChange = (changes: NodeChange<Node>[]) => {
    const selected = changes.filter((change): change is Extract<NodeChange<Node>, { type: 'select' }> => change.type === 'select' && !change.id.startsWith('section:'));
    if (selected.length) setSelection(previous => {
      const ids = new Set(previous.nodes);
      for (const change of selected) if (change.selected) ids.add(change.id); else ids.delete(change.id);
      return { ...previous, nodes: [...ids], sections: [] };
    });
    const resized = changes.filter((change): change is Extract<NodeChange<Node>, { type: 'dimensions' }> => change.type === 'dimensions' && !!change.dimensions);
    if (resized.length) setNodeMeasurements(previous => {
      let updated: Record<string, { width: number; height: number }> | undefined;
      for (const change of resized) {
        if (!change.dimensions || (previous[change.id]?.width === change.dimensions.width && previous[change.id]?.height === change.dimensions.height)) continue;
        updated ??= { ...previous };
        updated[change.id] = change.dimensions;
      }
      return updated ?? previous;
    });
    const moved = changes.filter((change): change is Extract<NodeChange<Node>, { type: 'position' }> => change.type === 'position' && !!change.position);
    if (!moved.length) return;
    const moving = new Set(moved.map(change => change.id));
    const positions = { ...draftRef.current.positions };
    let sections = [...draftRef.current.sections];
    for (const change of moved) {
      if (!change.position) continue;
      if (change.id.startsWith('section:')) {
        const id = change.id.slice(8);
        const section = sections.find(item => item.id === id);
        if (!section) continue;
        const dx = change.position.x - section.x;
        const dy = change.position.y - section.y;
        sections = sections.map(item => item.id === id ? { ...item, x: change.position!.x, y: change.position!.y } : item);
        for (const memberId of section.nodeIds) if (!moving.has(memberId)) {
          const point = positions[memberId] ?? defaultPosition(graph.nodes.findIndex(node => node.id === memberId));
          positions[memberId] = { x: point.x + dx, y: point.y + dy };
        }
      } else positions[change.id] = change.position;
    }
    setDraft({ ...draftRef.current, positions, sections });
  };
  const onEdgesChange = (changes: EdgeChange<Edge>[]) => {
    const selected = changes.filter((change): change is Extract<EdgeChange<Edge>, { type: 'select' }> => change.type === 'select');
    if (selected.length) setSelection(previous => {
      const ids = new Set(previous.edges);
      for (const change of selected) if (change.selected) ids.add(change.id); else ids.delete(change.id);
      return { ...previous, edges: [...ids], sections: [] };
    });
  };
  const canConnect = (connection: Connection | Edge) => {
    if (connection.source === connection.target) return false;
    const source = graph.nodes.find(node => node.id === connection.source);
    const target = graph.nodes.find(node => node.id === connection.target);
    if (!source || !target) return false;
    if (source.visitable) return target.visitable;
    let ancestorId: string | null = source.id;
    while (ancestorId !== null) {
      if (ancestorId === target.id) return false;
      ancestorId = graph.nodes.find(node => node.id === ancestorId)?.parentId ?? null;
    }
    return true;
  };
  const connect = (connection: Connection) => {
    if (!canConnect(connection)) { setMessage('Drag from a scene to another scene for a route, or from a folder to a scene or folder to organize it.'); return; }
    const source = graph.nodes.find(node => node.id === connection.source);
    if (source && !source.visitable) {
      const target = graph.nodes.find(node => node.id === connection.target);
      if (target?.parentId === source.id) { setMessage('That node is already in this folder.'); return; }
      dispatch({ kind: 'reparent-node', nodeId: connection.target, parentId: source.id });
      return;
    }
    openConnection(connection.source, connection.target);
  };
  const openConnection = (sourceId: string, targetId: string) => {
    setEditingAction(null);
    setEditingRoute(null);
    if (toolsDetailsRef.current) toolsDetailsRef.current.open = false;
    const destination = nodeLabels?.[targetId] ?? graph.nodes.find(node => node.id === targetId)?.title ?? 'next scene';
    const target = graphElement.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(targetId)}"]`);
    const bounds = target?.getBoundingClientRect();
    setRouteActionKind('choice');
    setRouteExistingAction('');
    setRouteActionText(`Go to ${destination}`);
    setPendingConnection({ sourceId, targetId, x: Math.max(8, Math.min(bounds?.right ?? window.innerWidth / 2, window.innerWidth - 336)), y: Math.max(8, Math.min(bounds?.top ?? window.innerHeight / 2, window.innerHeight - 280)) });
    setContextMenu(null);
  };
  const confirmConnection = () => {
    if (!pendingConnection) return;
    const { sourceId, targetId } = pendingConnection;
    const edge = currentRef.current.world.navigationEdges.find(item => item.fromNodeId === sourceId && item.toNodeId === targetId) ?? { id: newId('link'), fromNodeId: sourceId, toNodeId: targetId };
    if (routeActionKind !== 'route-only' && routeActionKind !== 'existing' && !routeActionText.trim()) { setMessage('Name the choice or command before connecting these scenes.'); return; }
    if (routeActionKind === 'existing') {
      const separator = routeExistingAction.indexOf(':');
      if (separator < 0) { setMessage('Choose an existing action to use this route.'); return; }
      if (dispatch({ kind: 'set-action-destination', sourceNodeId: sourceId, actionKind: routeExistingAction.slice(0, separator) as 'choice' | 'command', actionId: routeExistingAction.slice(separator + 1), toNodeId: targetId, newEdgeId: edge.id })) setPendingConnection(null);
      return;
    }
    if (dispatch(routeActionKind === 'route-only' ? { kind: 'link-nodes', edge } : {
      kind: 'connect-scenes', edge, actionId: `action-${crypto.randomUUID().replaceAll('-', '')}`,
      actionKind: routeActionKind, actionLabel: routeActionText.trim(),
    })) setPendingConnection(null);
  };

  const openRouteEditor = (edgeId: string) => {
    const edge = currentRef.current.world.navigationEdges.find(item => item.id === edgeId);
    if (!edge) return;
    setEditingAction(null);
    setEditingRoute(edgeId);
    setRouteDestination(edge.toNodeId);
    setContextMenu(null);
    setPendingConnection(null);
    if (toolsDetailsRef.current) toolsDetailsRef.current.open = false;
  };
  const editAction = editingAction && effectiveActions.get(editingAction.nodeId)?.[editingAction.kind === 'choice' ? 'choices' : 'commands'].find(action => action.id === editingAction.id);
  const actionInherited = editingAction && !editableWorld.nodes.find(node => node.id === editingAction.nodeId)?.actions?.[editingAction.kind === 'choice' ? 'choices' : 'commands'];
  const editedRoute = editableWorld.navigationEdges.find(edge => edge.id === editingRoute);
  const activeNodeId = selection.nodes[0] ?? '';
  const selectedNode = editableWorld.nodes.find((node) => node.id === activeNodeId);
  const createNode = (visitable: boolean, point?: { x: number; y: number }, parentId: string | null = selectedNode && !selectedNode.visitable ? selectedNode.id : null, visualSectionId?: string) => {
    setContextMenu(null);
    const id = newId(visitable ? 'scene' : 'folder');
    const selectedIndex = graph.nodes.findIndex(node => node.id === activeNodeId);
    const anchor = draftRef.current.positions[activeNodeId] ?? defaultPosition(Math.max(selectedIndex, 0));
    const occupied = graph.nodes.map((node, index) => draftRef.current.positions[node.id] ?? defaultPosition(index));
    const next = point ?? { x: anchor.x + 320, y: anchor.y };
    if (!point) while (occupied.some(position => Math.abs(position.x - next.x) < 200 && Math.abs(position.y - next.y) < 120)) next.y += 180;
    const result = applyGraphCommand(currentRef.current.world, {
      kind: 'add-node',
      node: {
        id,
        parentId,
        visitable,
        title: { kind: 'literal', text: visitable ? 'New scene' : 'New logic folder' },
        content: { kind: 'literal', text: '' },
      },
    });
    if (!result.ok) { setMessage(result.message); return; }
    let nextLayout = { ...currentRef.current.layout, positions: { ...currentRef.current.layout.positions, [id]: next } };
    if (visualSectionId) nextLayout = moveNodeToSection(nextLayout, id, visualSectionId);
    publish({ world: result.world, layout: nextLayout });
    selectNode(id);
  };
  const createSection = (point?: { x: number; y: number }, wrapSelection = false) => {
    const layout = currentRef.current.layout;
    const members = wrapSelection ? selection.nodes : [];
    const points = members.map(id => layout.positions[id] ?? defaultPosition(graph.nodes.findIndex(node => node.id === id)));
    const x = points.length ? Math.min(...points.map(item => item.x)) - 28 : point?.x ?? 0;
    const y = points.length ? Math.min(...points.map(item => item.y)) - 64 : point?.y ?? 0;
    const width = points.length ? Math.max(300, Math.max(...points.map((item, index) => item.x + (nodeMeasurements[members[index]!]?.width ?? 200))) - x + 28) : 360;
    const height = points.length ? Math.max(180, Math.max(...points.map((item, index) => item.y + (nodeMeasurements[members[index]!]?.height ?? 80))) - y + 28) : 240;
    const section: GraphSection = { id: crypto.randomUUID(), title: 'New section', x, y, width, height, collapsed: false, nodeIds: members };
    const sections = layout.sections.map(item => ({ ...item, nodeIds: item.nodeIds.filter(id => !members.includes(id)) }));
    commitLayout({ ...layout, sections: [...sections, section] });
    setSelection({ nodes: [], edges: [], sections: [section.id] });
    setContextMenu(null);
  };
  const requestGraphDeletion = (nodeIds: readonly string[], edgeIds: readonly string[]) => {
    const impact = previewGraphDeletion(currentRef.current.world, nodeIds, edgeIds);
    if (impact.actions.length) {
      const names = impact.actions.map(action => `${action.kind} “${localeStrings?.[action.label] ?? action.label}” in ${localeStrings?.[action.owner] ?? action.owner}`).join(', ');
      if (!window.confirm(`Remove the route and keep ${impact.actions.length} choice or command action${impact.actions.length === 1 ? '' : 's'}: ${names}? Their text, conditions, and effects remain. Their direct destination is cleared. Undo restores the whole edit.`)) return null;
    }
    return applyGraphCommand(currentRef.current.world, { kind: 'delete-selection', nodeIds, edgeIds });
  };
  const deleteSelected = () => {
    const result = selection.nodes.length || selection.edges.length
      ? requestGraphDeletion(selection.nodes, selection.edges)
      : { ok: true as const, world: currentRef.current.world };
    if (!result) return;
    if (!result.ok) { setMessage(result.message); return; }
    const removed = new Set(selection.nodes);
    const layout = currentRef.current.layout;
    const nextLayout: GraphLayout = { ...layout, positions: Object.fromEntries(Object.entries(layout.positions).filter(([id]) => !removed.has(id))),
      sections: layout.sections.filter(section => !selection.sections.includes(section.id)).map(section => ({ ...section, nodeIds: section.nodeIds.filter(id => !removed.has(id)) })) };
    publish({ world: result.world, layout: nextLayout });
    setSelection(emptySelection());
    setContextMenu(null);
  };
  const removeSelectedNode = (nodeId: string) => {
    setSelection({ nodes: [nodeId], edges: [], sections: [] });
    const result = requestGraphDeletion([nodeId], []);
    if (!result) return;
    if (result.ok) publish({ world: result.world, layout: { ...currentRef.current.layout, positions: Object.fromEntries(Object.entries(currentRef.current.layout.positions).filter(([id]) => id !== nodeId)), sections: currentRef.current.layout.sections.map(section => ({ ...section, nodeIds: section.nodeIds.filter(id => id !== nodeId) })) } });
    else setMessage(result.message);
    setContextMenu(null);
  };
  const removeSelectedLink = (edgeId: string) => {
    const containment = graph.containment.find(edge => edge.id === edgeId);
    if (containment) dispatch({ kind: 'reparent-node', nodeId: containment.childId, parentId: null });
    else {
      const result = requestGraphDeletion([], [edgeId]);
      if (!result) return;
      if (result.ok) publish({ ...currentRef.current, world: result.world });
      else setMessage(result.message);
    }
    setSelection(emptySelection());
    setContextMenu(null);
  };
  const openContextMenu = (event: MouseEvent | React.MouseEvent, kind: MenuTarget['kind'], id?: string) => {
    event.preventDefault();
    const point = flowInstance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 0, y: 0 };
    setContextMenu({ x: event.clientX, y: event.clientY, point, kind, ...(id ? { id } : {}) });
  };
  const insideSelectionBounds = (x: number, y: number) => {
    if (selectionCount < 2) return false;
    const ids = new Set([...selection.nodes, ...selection.edges, ...selection.sections.map(sectionId)]);
    const selected = [...(graphElement.current?.querySelectorAll('.react-flow__node[data-id], .react-flow__edge[data-id]') ?? [])]
      .filter(element => ids.has(element.getAttribute('data-id') ?? ''))
      .map(element => element.getBoundingClientRect());
    if (!selected.length) return false;
    return x >= Math.min(...selected.map(rect => rect.left)) && x <= Math.max(...selected.map(rect => rect.right))
      && y >= Math.min(...selected.map(rect => rect.top)) && y <= Math.max(...selected.map(rect => rect.bottom));
  };
  const selectAll = () => setSelection({ nodes: graph.nodes.filter(node => !hiddenNodes.has(node.id)).map(node => node.id), edges: edges.map(edge => edge.id), sections: draftLayout.sections.map(section => section.id) });
  const moveContextNodesToSection = (nodeId: string, targetSectionId: string | null) => {
    const ids = selection.nodes.includes(nodeId) ? selection.nodes : [nodeId];
    let layout = currentRef.current.layout;
    for (const id of ids) layout = moveNodeToSection(layout, id, targetSectionId);
    commitLayout(layout);
  };
  const nudge = (dx: number, dy: number) => {
    const layout = currentRef.current.layout;
    const positions = { ...layout.positions };
    const shifted = new Set(selection.nodes);
    const sections = layout.sections.map(section => {
      if (!selection.sections.includes(section.id)) return section;
      for (const id of section.nodeIds) shifted.add(id);
      return { ...section, x: section.x + dx, y: section.y + dy };
    });
    for (const id of shifted) {
      const point = positions[id] ?? defaultPosition(graph.nodes.findIndex(node => node.id === id));
      positions[id] = { x: point.x + dx, y: point.y + dy };
    }
    commitLayout({ ...layout, positions, sections });
  };
  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"],[role="menu"]') || target !== event.currentTarget && target.closest('button,summary')) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = graphElement.current?.getBoundingClientRect();
      const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      const point = flowInstance.current?.screenToFlowPosition({ x, y }) ?? { x: 0, y: 0 };
      setContextMenu({ kind: selectionCount > 1 ? 'selection' : 'pane', x, y, point });
    } else if (mod && key === 'a') { event.preventDefault(); selectAll(); }
    else if ((event.key === 'Delete' && !event.metaKey) || (event.metaKey && (event.key === 'Backspace' || event.key === 'Delete'))) { event.preventDefault(); deleteSelected(); }
    else if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (event.ctrlKey && key === 'y') { event.preventDefault(); redo(); }
    else if (event.key === 'Escape') { event.preventDefault(); if (contextMenu) setContextMenu(null); else setSelection(emptySelection()); }
    else if (event.key.startsWith('Arrow') && (selection.nodes.length || selection.sections.length)) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      nudge(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); void flowInstance.current?.zoomIn(); }
    else if (event.key === '-') { event.preventDefault(); void flowInstance.current?.zoomOut(); }
    else if (key === 'f' && !mod) { event.preventDefault(); void flowInstance.current?.fitView({ padding: .2 }); }
  };
  const menuAction = (run: () => void) => { run(); setContextMenu(null); graphElement.current?.focus(); };

  return (
    <section ref={graphElement} tabIndex={0} onKeyDown={keyDown} onPointerDownCapture={event => {
      if ((event.target as Element).closest('.react-flow__node')) selectionAtPointerDown.current = selection;
    }} aria-label="Apprentice node graph" data-map-tool={panTool || modifierPan ? 'pan' : 'select'} style={{ width: '100%', height: '100%', minHeight: 420 }}>
      <div data-tour="graph-toolbar" role="toolbar" aria-label="Graph editing" className="apprentice-graph-toolbar">
        <button type="button" className="button-primary" onClick={() => createNode(true)}><span aria-hidden="true">＋</span> Add scene</button>
        <div className="apprentice-map-search"><input type="search" aria-label="Find scene or logic folder" value={nodeQuery} onChange={event => setNodeQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && matchingNodes[0]) focusNode(matchingNodes[0].id); }} placeholder="Find scene or logic folder" />
          {nodeQuery.trim() && <div className="apprentice-map-search__results" aria-label="Map search results">{matchingNodes.slice(0, 30).map(node => <button key={node.id} type="button" onClick={() => focusNode(node.id)}>{nodeLabels?.[node.id] ?? node.title}</button>)}{matchingNodes.length > 30 && <span>Showing 30 of {matchingNodes.length}. Refine your search.</span>}{!matchingNodes.length && <span>No matching nodes.</span>}</div>}</div>
        <details ref={toolsDetailsRef} className="apprentice-graph-tools"><summary>Map tools</summary><div className="apprentice-graph-tools__panel">
        <div className="apprentice-graph-toolbar__group"><button type="button" onClick={() => createNode(false)}>Add logic folder</button><button type="button" onClick={() => createSection(undefined, selection.nodes.length > 0)}>Add section</button><button type="button" disabled={!past.length} onClick={undo}>Undo</button><button type="button" disabled={!future.length} onClick={redo}>Redo</button><button type="button" aria-pressed={panTool} onClick={() => setPanTool(value => !value)}>{panTool ? 'Pan tool' : 'Select tool'}</button></div>
        <label>
          <span>{selectedNode?.visitable ? 'Put scene in logic folder' : 'Put logic folder in logic folder'}</span>
          <select aria-label="Containment parent" value={selectedNode?.parentId ?? ''} disabled={!selectedNode} onChange={(event) => dispatch({ kind: 'reparent-node', nodeId: activeNodeId, parentId: event.target.value || null })}>
            <option value="">Top level</option>
            {graph.nodes.filter(node => !node.visitable && node.id !== activeNodeId).map(node => <option key={node.id} value={node.id}>{nodeLabels?.[node.id] ?? node.title}</option>)}
          </select>
        </label>
        <label>
          <span>Create playable choice to</span>
          <select aria-label="Navigation destination" value="" disabled={!selectedNode?.visitable} onChange={(event) => {
            const toNodeId = event.target.value;
            if (toNodeId) openConnection(activeNodeId, toNodeId);
          }}>
            <option value="">Choose destination</option>
            {graph.nodes.filter((node) => node.visitable && node.id !== activeNodeId).map((node) => <option key={node.id} value={node.id}>{nodeLabels?.[node.id] ?? node.title}</option>)}
          </select>
        </label>
        <div className="apprentice-graph-toolbar__group"><button type="button" disabled={selection.nodes.length !== 1 || !selectedNode?.visitable || selectedNode.id === editableWorld.entryNodeId} onClick={() => dispatch({ kind: 'set-entry-node', nodeId: activeNodeId })}>Make start scene</button><button type="button" disabled={!selection.nodes.length && !selection.edges.length && !selection.sections.length} onClick={deleteSelected}>Delete selected</button>
        <button type="button" disabled={!selection.edges.length} onClick={() => { if (selection.edges[0]) removeSelectedLink(selection.edges[0]); }}>{graph.containment.some(edge => edge.id === selection.edges[0]) ? 'Remove from logic folder' : 'Remove selected link'}</button></div>
        </div></details>
      </div>
      {selectionCount > 1 && <p className="apprentice-selection-count" role="status">{selectionCount} map items selected</p>}
      {!editableWorld.nodes.some(node => node.visitable) && <p className="apprentice-graph-message" role="status">No start scene yet. Add a scene to make this story playable.</p>}
      {selection.sections.length === 1 && !selection.nodes.length && <div className="apprentice-section-details"><label>Section name <input aria-label="Section name" value={draftLayout.sections.find(item => item.id === selection.sections[0])?.title ?? ''} onChange={event => commitLayout({ ...currentRef.current.layout, sections: currentRef.current.layout.sections.map(item => item.id === selection.sections[0] ? { ...item, title: event.target.value } : item) })} /></label></div>}
      {selection.edges.length === 1 && graph.navigation.some(edge => edge.id === selection.edges[0]) && <div className="apprentice-route-selection" role="toolbar" aria-label="Selected route">
        <button type="button" onClick={() => openRouteEditor(selection.edges[0]!)}>Change destination…</button>
        <button type="button" onClick={() => removeSelectedLink(selection.edges[0]!)}>Remove route, keep actions</button>
      </div>}
      {message && <p className="apprentice-graph-message" role="alert">{message}</p>}
      <div aria-label="Relationship legend" className="apprentice-graph-legend">Select a route, then drag its arrowhead to change destination. Drag empty space to select. Shift or Command/Ctrl plus drag to pan. <span>Scene → scene: creates a playable choice</span><span>Logic folder → node: inheritance</span><span>Section: canvas organization</span></div>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onlyRenderVisibleElements fitView={window.innerWidth >= 600} defaultViewport={{ x: 140, y: 80, zoom: 0.6 }} onInit={instance => { flowInstance.current = instance; }} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        selectionOnDrag={!panTool && !modifierPan} selectionMode={SelectionMode.Partial} selectNodesOnDrag={false} panOnDrag={panTool || modifierPan ? true : [1]} panOnScroll zoomOnScroll={false} zoomActivationKeyCode={['Meta', 'Control']} selectionKeyCode={null} multiSelectionKeyCode={['Shift', 'Meta', 'Control']} deleteKeyCode={null}
        onNodeDragStop={(_event, node) => {
          let next = draftRef.current;
          if (!node.id.startsWith('section:')) for (const id of selection.nodes.includes(node.id) ? selection.nodes : [node.id]) {
            const index = graph.nodes.findIndex(item => item.id === id);
            const point = next.positions[id] ?? defaultPosition(index);
            const section = sectionAtPoint(next, point.x + (nodeMeasurements[id]?.width ?? 200) / 2, point.y + (nodeMeasurements[id]?.height ?? 80) / 2);
            next = moveNodeToSection(next, id, section?.id ?? null);
          }
          commitLayout(next);
        }}
        isValidConnection={canConnect} onConnect={connect} reconnectRadius={18}
        onReconnectStart={() => { reconnectSucceeded.current = false; setMessage('Drag the arrowhead to another scene. The source stays fixed to preserve action ownership.'); }}
        onReconnect={(edge, connection) => {
          if (connection.source !== edge.source) { setMessage('The source stays fixed. Edit the action in its source scene to change ownership.'); return; }
          reconnectSucceeded.current = true;
          dispatch({ kind: 'retarget-route', edgeId: edge.id, toNodeId: connection.target });
        }}
        onReconnectEnd={() => { if (!reconnectSucceeded.current) setMessage('No destination changed. Drop the arrowhead on a different scene, or select the route and use Change destination.'); }}
        onNodeClick={(event, node) => {
          if (event.button !== 0) return;
          setContextMenu(null);
          if (node.id.startsWith('section:')) return;
          const before = selectionAtPointerDown.current ?? selection;
          selectionAtPointerDown.current = null;
          const additive = event.shiftKey || event.metaKey || event.ctrlKey;
          setSelection({ nodes: additive ? before.nodes.includes(node.id) ? before.nodes.filter(id => id !== node.id) : [...before.nodes, node.id] : [node.id], edges: additive ? before.edges : [], sections: additive ? before.sections : [] });
          notifySelectNode(additive && before.nodes.includes(node.id) && before.nodes.length === 1 ? undefined : node.id);
        }}
        onNodeContextMenu={(event, node) => { if (node.id.startsWith('section:')) { const id = node.id.slice(8); if (selectionCount > 1 && selection.sections.includes(id)) openContextMenu(event, 'selection'); else { setSelection({ nodes: [], edges: [], sections: [id] }); openContextMenu(event, 'section', id); } } else if (selectionCount > 1 && selection.nodes.includes(node.id)) openContextMenu(event, 'selection'); else { if (!selection.nodes.includes(node.id)) selectNode(node.id); openContextMenu(event, 'node', node.id); } }}
        onEdgeClick={(event, edge) => { if (event.button !== 0) return; setContextMenu(null); setSelection(previous => ({ nodes: event.shiftKey || event.metaKey || event.ctrlKey ? previous.nodes : [], edges: event.shiftKey || event.metaKey || event.ctrlKey ? [...new Set([...previous.edges, edge.id])] : [edge.id], sections: [] })); openRouteAction(edge.id); }}
        onEdgeContextMenu={(event, edge) => { if (selectionCount > 1 && selection.edges.includes(edge.id)) openContextMenu(event, 'selection'); else { if (!selection.edges.includes(edge.id)) setSelection({ nodes: [], edges: [edge.id], sections: [] }); openContextMenu(event, 'edge', edge.id); } }}
        onSelectionContextMenu={event => { if (selectionCount) openContextMenu(event, 'selection'); }}
        onPaneClick={event => { if (event.button !== 0) return; setContextMenu(null); setSelection(emptySelection()); setEditingAction(null); setEditingRoute(null); notifySelectNode(undefined); }} onPaneContextMenu={event => { if (insideSelectionBounds(event.clientX, event.clientY)) openContextMenu(event, 'selection'); else { setSelection(emptySelection()); notifySelectNode(undefined); openContextMenu(event, 'pane'); } }}>
        <Background />
        <Controls showFitView={false}><ControlButton onClick={() => void flowInstance.current?.fitView({ padding: 0.2, duration: 0 })} title="Fit all scenes in view" aria-label="Fit all scenes in view"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="6" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h9M6 8l5 8m6-7-4 7"/></svg></ControlButton></Controls>
      </ReactFlow>
      {editingAction && editAction && <form className="apprentice-route-popover apprentice-route-editor" role="dialog" aria-label="Edit player action" onSubmit={event => {
        event.preventDefault();
        const before = currentRef.current.world;
        const destination = applyGraphCommand(before, { kind: 'set-action-destination', sourceNodeId: editingAction.nodeId, actionKind: editingAction.kind, actionId: editingAction.id, toNodeId: actionDestination || null, newEdgeId: newId('link') });
        if (!destination.ok) { setMessage(destination.message); return; }
        const key = editingAction.kind === 'choice' ? 'choices' : 'commands';
        const next = { ...destination.world, nodes: destination.world.nodes.map(node => node.id !== editingAction.nodeId ? node : { ...node, actions: { ...node.actions, [key]: node.actions?.[key]?.map(action => {
          if (action.id !== editingAction.id) return action;
          if ('label' in action) return action.label.kind === 'literal' ? { ...action, label: { kind: 'literal', text: actionText } } : action;
          return { ...action, patterns: [actionText, ...action.patterns.slice(1)] };
        }) } }) };
        publish({ ...currentRef.current, world: next });
        setEditingAction(null);
      }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setEditingAction(null); }}>
        <strong>{editingAction.kind === 'choice' ? 'Player choice' : 'Typed command'}</strong>
        <p>{actionInherited ? 'Inherited action. Saving creates a local copy of this action category; other scenes keep their inherited actions.' : 'Local action. Conditions and effects are preserved.'}</p>
        <label>{editingAction.kind === 'choice' ? 'Choice text' : 'Command words'} <input autoFocus value={actionText} readOnly={'label' in editAction && editAction.label.kind === 'locale-key'} onChange={event => setActionText(event.target.value)} /></label>
        {'label' in editAction && editAction.label.kind === 'locale-key' && <p>This text uses a translation key. Open details to edit its translations.</p>}
        <label>Destination <select aria-label="Action destination" value={actionDestination} onChange={event => setActionDestination(event.target.value)}><option value="">No direct destination</option>{graph.nodes.filter(node => node.visitable && node.id !== editingAction.nodeId).map(node => <option key={node.id} value={node.id}>{nodeLabels?.[node.id] ?? node.title}</option>)}</select></label>
        {message && <p role="alert">{message}</p>}
        <button type="button" onClick={() => { onOpenActions?.(editingAction.nodeId, { kind: editingAction.kind, id: editingAction.id }); setEditingAction(null); }}>Open details</button>
        <div><button type="button" onClick={() => setEditingAction(null)}>Cancel</button><button type="submit">Save action</button></div>
      </form>}
      {editedRoute && <form className="apprentice-route-popover apprentice-route-editor" role="dialog" aria-label="Change route destination" onSubmit={event => {
        event.preventDefault();
        if (dispatch({ kind: 'retarget-route', edgeId: editedRoute.id, toNodeId: routeDestination })) setEditingRoute(null);
      }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setEditingRoute(null); graphElement.current?.focus(); } }}>
        <strong>Change destination from {nodeLabels?.[editedRoute.fromNodeId] ?? 'scene'}</strong>
        <p>This changes the shared route for every attached action and advanced reference. Source ownership stays fixed.</p>
        <div className="apprentice-route-actions">{(routeActionLabels.get(editedRoute.id) ?? ['Advanced route, no direct player action']).map((label, index) => <p key={index}>{label}</p>)}</div>
        <label>Destination <select autoFocus aria-label="Route destination" value={routeDestination} onChange={event => setRouteDestination(event.target.value)}>{graph.nodes.filter(node => node.visitable && node.id !== editedRoute.fromNodeId).map(node => <option key={node.id} value={node.id}>{nodeLabels?.[node.id] ?? node.title}</option>)}</select></label>
        {message && <p role="alert">{message}</p>}
        <button type="button" onClick={() => { openRouteAction(editedRoute.id); setEditingRoute(null); }}>Open action details</button>
        <div><button type="button" onClick={() => { setEditingRoute(null); graphElement.current?.focus(); }}>Cancel</button><button type="submit">Apply destination</button></div>
      </form>}
      {pendingConnection && <form className="apprentice-route-popover" role="dialog" aria-label="Connect scenes" style={{ left: pendingConnection.x, top: pendingConnection.y }} onSubmit={event => { event.preventDefault(); confirmConnection(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); setPendingConnection(null); graphElement.current?.focus(); } }}>
        <strong>{nodeLabels?.[pendingConnection.sourceId] ?? 'Scene'} → {nodeLabels?.[pendingConnection.targetId] ?? 'Scene'}</strong>
        <p>{editableWorld.navigationEdges.some(edge => edge.fromNodeId === pendingConnection.sourceId && edge.toNodeId === pendingConnection.targetId) ? 'This route already exists. Add or attach a player action to make it usable.' : 'What should the player do to travel here?'}</p>
        <label>Interaction <select aria-label="Route interaction" value={routeActionKind === 'existing' ? `existing:${routeExistingAction}` : routeActionKind} onChange={event => { const value = event.target.value; if (value.startsWith('existing:')) { setRouteExistingAction(value.slice(9)); setRouteActionKind('existing'); return; } const kind = value as typeof routeActionKind; setRouteActionKind(kind); setRouteActionText(kind === 'command' ? `go to ${(nodeLabels?.[pendingConnection.targetId] ?? 'scene').toLowerCase()}` : kind === 'choice' ? `Go to ${nodeLabels?.[pendingConnection.targetId] ?? 'scene'}` : ''); }}><option value="choice">Click a choice</option><option value="command">Type a command</option>{(() => { const actions = effectiveActions.get(pendingConnection.sourceId); return <>{(actions?.choices ?? []).filter(action => !action.navigationEdgeId).map(action => <option key={`choice:${action.id}`} value={`existing:choice:${action.id}`}>Use existing choice: {labelText(action.label)}</option>)}{(actions?.commands ?? []).filter(action => !action.navigationEdgeId).map(action => <option key={`command:${action.id}`} value={`existing:command:${action.id}`}>Use existing command: {action.patterns[0] ?? action.id}</option>)}</>; })()}{!editableWorld.navigationEdges.some(edge => edge.fromNodeId === pendingConnection.sourceId && edge.toNodeId === pendingConnection.targetId) && <option value="route-only">Route only (advanced)</option>}</select></label>
        {(routeActionKind === 'choice' || routeActionKind === 'command') && <label>{routeActionKind === 'choice' ? 'Choice text' : 'Command words'} <input ref={routeTextRef} aria-label={routeActionKind === 'choice' ? 'Choice text' : 'Command words'} value={routeActionText} onChange={event => setRouteActionText(event.target.value)} /></label>}
        {routeActionKind === 'existing' && <p>The selected action keeps its current text, conditions, and effects.</p>}
        {routeActionKind === 'route-only' && <p>This arrow will not give players a choice or command. Use it for an authored effect or rule.</p>}
        <div><button type="button" onClick={() => { setPendingConnection(null); graphElement.current?.focus(); }}>Cancel</button><button type="submit" className="button-primary">Create connection</button></div>
      </form>}
      {contextMenu && <div ref={menuRef} className="apprentice-context-menu" role="menu" aria-label="Map actions" style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); setContextMenu(null); graphElement.current?.focus(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]; const index = items.indexOf(document.activeElement as HTMLElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
      }}>
        {contextMenu.kind === 'pane' && <><button role="menuitem" onClick={() => menuAction(() => createNode(true, contextMenu.point, null, sectionAtPoint(currentRef.current.layout, contextMenu.point.x, contextMenu.point.y)?.id))}>New scene here</button><button role="menuitem" onClick={() => menuAction(() => createSection(contextMenu.point))}>New section here</button><button role="menuitem" onClick={() => menuAction(() => createNode(false, contextMenu.point, null, sectionAtPoint(currentRef.current.layout, contextMenu.point.x, contextMenu.point.y)?.id))}>New logic folder here</button><button role="menuitem" onClick={() => menuAction(selectAll)}>Select all</button><button role="menuitem" onClick={() => menuAction(() => { void flowInstance.current?.fitView({ padding: .2 }); })}>Fit visible content</button></>}
        {contextMenu.kind === 'selection' && <><p>{selectionCount} map items selected</p>{selection.nodes.length > 0 && <button role="menuitem" onClick={() => menuAction(() => createSection(undefined, true))}>Create section around selected</button>}{selection.nodes.length > 0 && draftLayout.sections.map(section => <button key={section.id} role="menuitem" onClick={() => menuAction(() => moveContextNodesToSection(selection.nodes[0]!, section.id))}>Move selected to section: {section.title}</button>)}{selection.nodes.some(id => draftLayout.sections.some(section => section.nodeIds.includes(id))) && <button role="menuitem" onClick={() => menuAction(() => moveContextNodesToSection(selection.nodes[0]!, null))}>Remove selected from sections</button>}<button role="menuitem" onClick={() => menuAction(deleteSelected)}>Delete selected items</button><button role="menuitem" onClick={() => menuAction(() => setSelection(emptySelection()))}>Clear selection</button></>}
        {contextMenu.kind === 'section' && <><p>{draftLayout.sections.find(item => item.id === contextMenu.id)?.title}</p><button role="menuitem" onClick={() => menuAction(() => createNode(true, contextMenu.point, null, contextMenu.id))}>New scene in section</button><button role="menuitem" onClick={() => menuAction(() => createNode(false, contextMenu.point, null, contextMenu.id))}>New logic folder in section</button><button role="menuitem" onClick={() => menuAction(() => { const title = window.prompt('Section name', draftLayout.sections.find(item => item.id === contextMenu.id)?.title); if (title !== null) commitLayout({ ...currentRef.current.layout, sections: currentRef.current.layout.sections.map(item => item.id === contextMenu.id ? { ...item, title } : item) }); })}>Rename</button><button role="menuitem" onClick={() => menuAction(() => toggleSection(contextMenu.id!))}>{draftLayout.sections.find(item => item.id === contextMenu.id)?.collapsed ? 'Expand' : 'Collapse'}</button><button role="menuitem" onClick={() => menuAction(() => { setSelection({ nodes: [], edges: [], sections: [] }); commitLayout({ ...currentRef.current.layout, sections: currentRef.current.layout.sections.filter(item => item.id !== contextMenu.id) }); })}>Delete section</button></>}
        {contextMenu.kind === 'node' && <><p>{selection.nodes.length > 1 ? `${selection.nodes.length} nodes selected` : nodeLabels?.[contextMenu.id!] ?? 'Selected node'}</p><button role="menuitem" onClick={() => menuAction(() => createNode(true, contextMenu.point, graph.nodes.find(node => node.id === contextMenu.id)?.visitable ? null : contextMenu.id!))}>{graph.nodes.find(node => node.id === contextMenu.id)?.visitable ? 'Add scene nearby' : 'New scene inside'}</button>{!graph.nodes.find(node => node.id === contextMenu.id)?.visitable && <button role="menuitem" onClick={() => menuAction(() => createNode(false, contextMenu.point, contextMenu.id!))}>New logic folder inside</button>}{graph.nodes.find(node => node.id === contextMenu.id)?.visitable && contextMenu.id !== editableWorld.entryNodeId && <button role="menuitem" onClick={() => menuAction(() => dispatch({ kind: 'set-entry-node', nodeId: contextMenu.id! }))}>Make start scene</button>}{draftLayout.sections.map(section => <button key={section.id} role="menuitem" onClick={() => menuAction(() => moveContextNodesToSection(contextMenu.id!, section.id))}>Move {selection.nodes.length > 1 ? 'selected to' : 'to'} section: {section.title}</button>)}{draftLayout.sections.some(section => section.nodeIds.includes(contextMenu.id!)) && <button role="menuitem" onClick={() => menuAction(() => moveContextNodesToSection(contextMenu.id!, null))}>Remove {selection.nodes.length > 1 ? 'selected from' : 'from'} section</button>}{selection.nodes.length + selection.edges.length + selection.sections.length > 1 ? <button role="menuitem" onClick={() => menuAction(deleteSelected)}>Delete selected items</button> : <button role="menuitem" onClick={() => menuAction(() => removeSelectedNode(contextMenu.id!))}>Delete node</button>}</>}
        {contextMenu.kind === 'edge' && <>{(() => { const edge = graph.navigation.find(item => item.id === contextMenu.id); return edge && <><button role="menuitem" onClick={() => menuAction(() => openRouteEditor(edge.id))}>Change destination…</button><button role="menuitem" onClick={() => menuAction(() => openConnection(edge.fromNodeId, edge.toNodeId))}>Add player action to route</button></>; })()}<button role="menuitem" onClick={() => menuAction(() => removeSelectedLink(contextMenu.id!))}>{graph.containment.some(edge => edge.id === contextMenu.id) ? 'Remove from logic folder' : 'Remove route, keep actions'}</button></>}
      </div>}
    </section>
  );
}
