import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, ControlButton, Controls, MarkerType, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorldDocument } from '@dungeon-scrivener/model';
import { createGraphHistory, dispatchGraphCommand, redoGraphEdit, undoGraphEdit, type GraphHistory } from './commands.js';
import { projectGraph } from './graph.js';

export interface ApprenticeGraphProps {
  readonly world: WorldDocument;
  readonly positions?: GraphPositions;
  readonly onPositionsChange?: (positions: GraphPositions) => void;
  readonly nodeLabels?: Readonly<Record<string, string>>;
  readonly selectedNodeId?: string;
  readonly onSelectNode?: (nodeId: string) => void;
  readonly onWorldChange?: (world: WorldDocument) => void;
}

export type GraphPositions = Readonly<Record<string, { readonly x: number; readonly y: number }>>;

const defaultPosition = (index: number) => ({ x: 0, y: index * 180 });
const EMPTY_POSITIONS: GraphPositions = {};
const newId = (kind: 'scene' | 'folder' | 'link') => `${kind}-${crypto.randomUUID().replaceAll('-', '')}`;

/** World edits use structured commands; map coordinates are separate authoring metadata. */
export function ApprenticeGraph({ world, positions = EMPTY_POSITIONS, onPositionsChange, nodeLabels, selectedNodeId, onSelectNode, onWorldChange }: ApprenticeGraphProps) {
  const [history, setHistory] = useState<GraphHistory>(() => createGraphHistory(world));
  const [nodePositions, setNodePositions] = useState<GraphPositions>(positions);
  const positionsRef = useRef<GraphPositions>(positions);
  const [nodeMeasurements, setNodeMeasurements] = useState<Readonly<Record<string, { width: number; height: number }>>>({});
  const [activeNodeId, setActiveNodeId] = useState(selectedNodeId ?? '');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [nodeQuery, setNodeQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId?: string; edgeId?: string } | null>(null);
  const lastEmittedWorld = useRef<WorldDocument | null>(null);
  const lastWorld = useRef(world);
  const graphElement = useRef<HTMLElement>(null);
  const flowInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  useEffect(() => {
    positionsRef.current = positions;
    setNodePositions(positions);
  }, [positions]);
  useEffect(() => {
    if (world === lastEmittedWorld.current) {
      lastEmittedWorld.current = null;
      lastWorld.current = world;
      return;
    }
    if (world === lastWorld.current) return;
    lastWorld.current = world;
    setHistory(createGraphHistory(world));
  }, [world]);
  const editableWorld = history.world;
  const graph = useMemo(() => projectGraph(editableWorld), [editableWorld]);
  const matchingNodes = useMemo(() => nodeQuery.trim() ? graph.nodes.filter(node =>
    `${nodeLabels?.[node.id] ?? node.title} ${node.id}`.toLocaleLowerCase().includes(nodeQuery.trim().toLocaleLowerCase())) : [], [graph.nodes, nodeLabels, nodeQuery]);
  const focusNode = (id: string) => {
    const index = graph.nodes.findIndex(node => node.id === id);
    const point = positionsRef.current[id] ?? defaultPosition(index);
    setActiveNodeId(id);
    onSelectNode?.(id);
    setNodeQuery('');
    void flowInstance.current?.setCenter(point.x + 100, point.y + 40, { zoom: Math.max(flowInstance.current.getZoom(), 0.9), duration: 180 });
  };
  const nodes: Node[] = graph.nodes.map((node, index) => ({
    id: node.id,
    position: nodePositions[node.id] ?? defaultPosition(index),
    ...(nodeMeasurements[node.id] ? { measured: nodeMeasurements[node.id] } : {}),
    data: { label: <><span>{node.visitable ? 'Scene' : 'Folder'}: {nodeLabels?.[node.id] ?? node.title}</span>{!node.visitable && <small className="apprentice-node-kind">Organizes scenes</small>}{node.id === (selectedNodeId ?? activeNodeId) && <strong className="apprentice-node-selected">Selected</strong>}</> },
    selected: node.id === (selectedNodeId ?? activeNodeId),
    connectable: true,
    className: node.visitable ? 'apprentice-scene-node' : 'apprentice-folder-node',
    style: { borderRadius: node.visitable ? 8 : 5, border: node.visitable ? '2px solid #365b78' : '2px dashed #a36b3f', padding: 12, minWidth: 178 },
  }));
  const edges: Edge[] = [
    ...graph.containment.map((edge) => ({ id: edge.id, source: edge.parentId, target: edge.childId, label: 'contains', type: 'step', selected: edge.id === selectedEdgeId, style: { stroke: '#a36b3f', strokeWidth: 2.5, strokeDasharray: '6 5' }, labelStyle: { fill: '#7a4a2c', fontWeight: 700 } })),
    ...graph.navigation.map((edge) => ({ id: edge.id, source: edge.fromNodeId, target: edge.toNodeId, label: 'leads to', type: 'default', selected: edge.id === selectedEdgeId, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#087b69' }, style: { stroke: '#087b69', strokeWidth: 3.5 }, labelStyle: { fill: '#075b50', fontWeight: 700 } })),
  ];

  const updatePositions = (next: GraphPositions) => {
    positionsRef.current = next;
    setNodePositions(next);
  };
  const onNodesChange = (changes: NodeChange<Node>[]) => {
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
    const next = { ...positionsRef.current };
    for (const change of moved) if (change.position) next[change.id] = change.position;
    updatePositions(next);
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
    if (graph.navigation.some(edge => edge.fromNodeId === connection.source && edge.toNodeId === connection.target)) {
      setMessage('Those scenes already have a navigation link.');
      return;
    }
    dispatch({ kind: 'link-nodes', edge: { id: newId('link'), fromNodeId: connection.source, toNodeId: connection.target } });
  };

  const dispatch = (command: Parameters<typeof dispatchGraphCommand>[1]) => {
    const outcome = dispatchGraphCommand(history, command);
    setHistory(outcome.history);
    if (outcome.result.ok) { lastEmittedWorld.current = outcome.result.world; onWorldChange?.(outcome.result.world); }
    setMessage(outcome.result.ok ? '' : outcome.result.message);
  };
  const undo = () => {
    const next = undoGraphEdit(history);
    setHistory(next);
    if (next.world !== history.world) { lastEmittedWorld.current = next.world; onWorldChange?.(next.world); }
  };
  const redo = () => {
    const next = redoGraphEdit(history);
    setHistory(next);
    if (next.world !== history.world) { lastEmittedWorld.current = next.world; onWorldChange?.(next.world); }
  };
  const selectedNode = editableWorld.nodes.find((node) => node.id === activeNodeId);
  const createNode = (visitable: boolean) => {
    setContextMenu(null);
    const id = newId(visitable ? 'scene' : 'folder');
    const selectedIndex = graph.nodes.findIndex(node => node.id === activeNodeId);
    const anchor = positionsRef.current[activeNodeId] ?? defaultPosition(Math.max(selectedIndex, 0));
    const occupied = graph.nodes.map((node, index) => positionsRef.current[node.id] ?? defaultPosition(index));
    const next = { x: anchor.x + 320, y: anchor.y };
    while (occupied.some(point => Math.abs(point.x - next.x) < 200 && Math.abs(point.y - next.y) < 120)) next.y += 180;
    const nextPositions = { ...positionsRef.current, [id]: next };
    updatePositions(nextPositions);
    onPositionsChange?.(nextPositions);
    const flow = flowInstance.current;
    if (flow) void flow.setCenter((anchor.x + next.x + 178) / 2, (anchor.y + next.y + 70) / 2, {
      zoom: graphElement.current && graphElement.current.clientWidth < 600 ? 0.7 : Math.max(flow.getZoom(), 0.85),
      duration: 0,
    });
    dispatch({
      kind: 'add-node',
      node: {
        id,
        parentId: selectedNode && !selectedNode.visitable ? selectedNode.id : null,
        visitable,
        title: { kind: 'literal', text: visitable ? 'New scene' : 'New folder' },
        content: { kind: 'literal', text: '' },
      },
    });
    setActiveNodeId(id);
    onSelectNode?.(id);
  };
  const removeSelectedNode = (nodeId: string) => {
    dispatch({ kind: 'delete-node', nodeId });
    setContextMenu(null);
  };
  const removeSelectedLink = (edgeId: string) => {
    const containment = graph.containment.find(edge => edge.id === edgeId);
    if (containment) dispatch({ kind: 'reparent-node', nodeId: containment.childId, parentId: null });
    else dispatch({ kind: 'remove-link', edgeId });
    setSelectedEdgeId(null);
    setContextMenu(null);
  };
  const openContextMenu = (event: React.MouseEvent, target: { nodeId?: string; edgeId?: string }) => {
    event.preventDefault();
    const rect = graphElement.current?.getBoundingClientRect();
    if (!rect) return;
    setContextMenu({ x: Math.max(8, Math.min(event.clientX - rect.left, rect.width - 210)), y: Math.max(8, Math.min(event.clientY - rect.top, rect.height - 190)), ...target });
  };

  return (
    <section ref={graphElement} aria-label="Apprentice node graph" style={{ width: '100%', height: '100%', minHeight: 420 }}>
      <div data-tour="graph-toolbar" role="toolbar" aria-label="Graph editing" className="apprentice-graph-toolbar">
        <button type="button" className="button-primary" onClick={() => createNode(true)}><span aria-hidden="true">＋</span> Add scene</button>
        <div className="apprentice-map-search"><input type="search" aria-label="Find scene or folder" value={nodeQuery} onChange={event => setNodeQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && matchingNodes[0]) focusNode(matchingNodes[0].id); }} placeholder="Find scene or folder" />
          {nodeQuery.trim() && <div className="apprentice-map-search__results" aria-label="Map search results">{matchingNodes.slice(0, 30).map(node => <button key={node.id} type="button" onClick={() => focusNode(node.id)}>{nodeLabels?.[node.id] ?? node.title}</button>)}{matchingNodes.length > 30 && <span>Showing 30 of {matchingNodes.length}. Refine your search.</span>}{!matchingNodes.length && <span>No matching nodes.</span>}</div>}</div>
        <details className="apprentice-graph-tools"><summary>Map tools</summary><div className="apprentice-graph-tools__panel">
        <div className="apprentice-graph-toolbar__group"><button type="button" onClick={() => createNode(false)}>Add folder</button><button type="button" disabled={!history.past.length} onClick={undo}>Undo</button><button type="button" disabled={!history.future.length} onClick={redo}>Redo</button></div>
        <label>
          <span>{selectedNode?.visitable ? 'Put scene in folder' : 'Put folder in folder'}</span>
          <select aria-label="Containment parent" value={selectedNode?.parentId ?? ''} disabled={!selectedNode} onChange={(event) => dispatch({ kind: 'reparent-node', nodeId: activeNodeId, parentId: event.target.value || null })}>
            <option value="">Top level</option>
            {graph.nodes.filter(node => !node.visitable && node.id !== activeNodeId).map(node => <option key={node.id} value={node.id}>{nodeLabels?.[node.id] ?? node.title}</option>)}
          </select>
        </label>
        <label>
          <span>Link selected scene to</span>
          <select aria-label="Navigation destination" value="" disabled={!selectedNode?.visitable} onChange={(event) => {
            const toNodeId = event.target.value;
            if (toNodeId) dispatch({ kind: 'link-nodes', edge: { id: newId('link'), fromNodeId: activeNodeId, toNodeId } });
          }}>
            <option value="">Choose destination</option>
            {graph.nodes.filter((node) => node.visitable && node.id !== activeNodeId).map((node) => <option key={node.id} value={node.id}>{nodeLabels?.[node.id] ?? node.title}</option>)}
          </select>
        </label>
        <div className="apprentice-graph-toolbar__group"><button type="button" disabled={!selectedNode || activeNodeId === editableWorld.entryNodeId} onClick={() => removeSelectedNode(activeNodeId)}>Delete selected</button>
        <button type="button" disabled={!selectedEdgeId} onClick={() => { if (selectedEdgeId) removeSelectedLink(selectedEdgeId); }}>{graph.containment.some(edge => edge.id === selectedEdgeId) ? 'Remove from folder' : 'Remove selected link'}</button></div>
        </div></details>
      </div>
      {message && <p className="apprentice-graph-message" role="alert">{message}</p>}
      <div aria-label="Relationship legend" className="apprentice-graph-legend">Drag boxes to arrange. Drag from a lower dot to an upper dot. <span>Scene → scene: player route</span><span>Folder → scene or folder: contains it</span></div>
      <ReactFlow nodes={nodes} edges={edges} onlyRenderVisibleElements fitView={window.innerWidth >= 600} defaultViewport={{ x: 140, y: 80, zoom: 0.6 }} onInit={instance => { flowInstance.current = instance; }} onNodesChange={onNodesChange}
        onNodeDragStop={(_event, node) => { const next = { ...positionsRef.current, [node.id]: node.position }; updatePositions(next); onPositionsChange?.(next); }}
        isValidConnection={canConnect} onConnect={connect}
        onNodeClick={(_event, node) => { setContextMenu(null); setActiveNodeId(node.id); setSelectedEdgeId(null); onSelectNode?.(node.id); }}
        onNodeContextMenu={(event, node) => { setActiveNodeId(node.id); setSelectedEdgeId(null); onSelectNode?.(node.id); openContextMenu(event, { nodeId: node.id }); }}
        onEdgeClick={(_event, edge) => { setContextMenu(null); setSelectedEdgeId(edge.id); }}
        onEdgeContextMenu={(event, edge) => { setSelectedEdgeId(edge.id); openContextMenu(event, { edgeId: edge.id }); }}
        onPaneClick={() => setContextMenu(null)}>
        <Background />
        <Controls showFitView={false}><ControlButton onClick={() => void flowInstance.current?.fitView({ padding: 0.2, duration: 0 })} title="Fit all scenes in view" aria-label="Fit all scenes in view"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="6" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h9M6 8l5 8m6-7-4 7"/></svg></ControlButton></Controls>
      </ReactFlow>
      {contextMenu && <div className="apprentice-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={event => { if (event.key === 'Escape') setContextMenu(null); }}>
        {contextMenu.nodeId && <><p>{nodeLabels?.[contextMenu.nodeId] ?? 'Selected node'}</p><button type="button" role="menuitem" onClick={() => createNode(true)}>Add scene nearby</button><button type="button" role="menuitem" disabled={contextMenu.nodeId === editableWorld.entryNodeId} onClick={() => removeSelectedNode(contextMenu.nodeId!)}>Delete node</button></>}
        {contextMenu.edgeId && <button type="button" role="menuitem" onClick={() => removeSelectedLink(contextMenu.edgeId!)}>{graph.containment.some(edge => edge.id === contextMenu.edgeId) ? 'Remove from folder' : 'Remove navigation link'}</button>}
      </div>}
    </section>
  );
}
