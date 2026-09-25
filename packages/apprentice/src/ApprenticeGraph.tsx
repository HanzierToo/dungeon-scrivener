import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type ReactFlowInstance } from '@xyflow/react';
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
  const lastEmittedWorld = useRef<string | null>(null);
  const lastWorld = useRef(JSON.stringify(world));
  const graphElement = useRef<HTMLElement>(null);
  const flowInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  useEffect(() => {
    positionsRef.current = positions;
    setNodePositions(positions);
  }, [positions]);
  useEffect(() => {
    const nextWorld = JSON.stringify(world);
    if (nextWorld === lastEmittedWorld.current) {
      lastEmittedWorld.current = null;
      lastWorld.current = nextWorld;
      return;
    }
    if (nextWorld === lastWorld.current) return;
    lastWorld.current = nextWorld;
    setHistory(createGraphHistory(world));
  }, [world]);
  const editableWorld = history.world;
  const graph = useMemo(() => projectGraph(editableWorld), [editableWorld]);
  const nodes: Node[] = graph.nodes.map((node, index) => ({
    id: node.id,
    position: nodePositions[node.id] ?? defaultPosition(index),
    ...(nodeMeasurements[node.id] ? { measured: nodeMeasurements[node.id] } : {}),
    data: { label: <><span>{node.visitable ? 'Scene' : 'Folder'}: {nodeLabels?.[node.id] ?? node.title}</span>{node.id === (selectedNodeId ?? activeNodeId) && <strong className="apprentice-node-selected">Selected</strong>}</> },
    selected: node.id === (selectedNodeId ?? activeNodeId),
    connectable: node.visitable,
    style: { borderRadius: node.visitable ? 8 : 3, border: node.visitable ? '2px solid #365b78' : '2px dashed #777', padding: 12, minWidth: 178 },
  }));
  const edges: Edge[] = [
    ...graph.containment.map((edge) => ({ id: edge.id, source: edge.parentId, target: edge.childId, label: 'contains', type: 'step', style: { stroke: '#8b8f91', strokeWidth: 2, strokeDasharray: '6 5' }, labelStyle: { fill: '#555' }, selectable: false })),
    ...graph.navigation.map((edge) => ({ id: edge.id, source: edge.fromNodeId, target: edge.toNodeId, label: 'leads to', type: 'default', selected: edge.id === selectedEdgeId, markerEnd: { type: MarkerType.ArrowClosed, width: 28, height: 28, color: '#087b69' }, style: { stroke: '#087b69', strokeWidth: 3.5 }, labelStyle: { fill: '#075b50', fontWeight: 700 } })),
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
  const canConnect = (connection: Connection | Edge) => connection.source !== connection.target
    && graph.nodes.some(node => node.id === connection.source && node.visitable)
    && graph.nodes.some(node => node.id === connection.target && node.visitable);
  const connect = (connection: Connection) => {
    if (!canConnect(connection)) { setMessage('Connect the bottom dot of one scene to the top dot of another scene.'); return; }
    if (graph.navigation.some(edge => edge.fromNodeId === connection.source && edge.toNodeId === connection.target)) {
      setMessage('Those scenes already have a navigation link.');
      return;
    }
    dispatch({ kind: 'link-nodes', edge: { id: newId('link'), fromNodeId: connection.source, toNodeId: connection.target } });
  };

  const dispatch = (command: Parameters<typeof dispatchGraphCommand>[1]) => {
    const outcome = dispatchGraphCommand(history, command);
    setHistory(outcome.history);
    if (outcome.result.ok) { lastEmittedWorld.current = JSON.stringify(outcome.result.world); onWorldChange?.(outcome.result.world); }
    setMessage(outcome.result.ok ? '' : outcome.result.message);
  };
  const undo = () => {
    const next = undoGraphEdit(history);
    setHistory(next);
    if (next.world !== history.world) { lastEmittedWorld.current = JSON.stringify(next.world); onWorldChange?.(next.world); }
  };
  const redo = () => {
    const next = redoGraphEdit(history);
    setHistory(next);
    if (next.world !== history.world) { lastEmittedWorld.current = JSON.stringify(next.world); onWorldChange?.(next.world); }
  };
  const nodeIds = editableWorld.nodes.map((node) => node.id);
  const selectedNode = editableWorld.nodes.find((node) => node.id === activeNodeId);
  const createNode = (visitable: boolean) => {
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
        parentId: null,
        visitable,
        title: { kind: 'literal', text: visitable ? 'New scene' : 'New folder' },
        content: { kind: 'literal', text: '' },
      },
    });
    setActiveNodeId(id);
    onSelectNode?.(id);
  };

  return (
    <section ref={graphElement} aria-label="Apprentice node graph" style={{ width: '100%', height: '100%', minHeight: 420 }}>
      <div data-tour="graph-toolbar" role="toolbar" aria-label="Graph editing" className="apprentice-graph-toolbar">
        <div className="apprentice-graph-toolbar__group"><button type="button" onClick={() => createNode(true)}>Add scene</button><button type="button" onClick={() => createNode(false)}>Add folder</button></div>
        <div className="apprentice-graph-toolbar__group"><button type="button" disabled={!history.past.length} onClick={undo}>Undo</button><button type="button" disabled={!history.future.length} onClick={redo}>Redo</button></div>
        <label>
          <span>Move selected node under</span>
          <select aria-label="Containment parent" value={selectedNode?.parentId ?? ''} disabled={!selectedNode} onChange={(event) => dispatch({ kind: 'reparent-node', nodeId: activeNodeId, parentId: event.target.value || null })}>
            <option value="">No parent</option>
            {nodeIds.filter((id) => id !== activeNodeId).map((id) => <option key={id} value={id}>{nodeLabels?.[id] ?? graph.nodes.find((node) => node.id === id)?.title ?? id}</option>)}
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
        <button type="button" disabled={!selectedNode || activeNodeId === editableWorld.entryNodeId} onClick={() => dispatch({ kind: 'delete-node', nodeId: activeNodeId })}>Delete selected</button>
        <button type="button" disabled={!selectedEdgeId} onClick={() => { if (selectedEdgeId) dispatch({ kind: 'remove-link', edgeId: selectedEdgeId }); setSelectedEdgeId(null); }}>Remove selected link</button>
      </div>
      {message && <p className="apprentice-graph-message" role="alert">{message}</p>}
      <div aria-label="Relationship legend" className="apprentice-graph-legend">
        <span>Drag a scene to arrange the map. Drag its bottom dot to another scene’s top dot to link them.</span>
        <span>Teal arrow: authored route. Assign it to a scene action in the inspector. Click an arrow to select it for removal.</span>
        <span>Dashed grey line: folder containment.</span>
      </div>
      <ReactFlow nodes={nodes} edges={edges} fitView onInit={instance => { flowInstance.current = instance; }} onNodesChange={onNodesChange}
        onNodeDragStop={(_event, node) => { const next = { ...positionsRef.current, [node.id]: node.position }; updatePositions(next); onPositionsChange?.(next); }}
        isValidConnection={canConnect} onConnect={connect}
        onNodeClick={(_event, node) => { setActiveNodeId(node.id); setSelectedEdgeId(null); onSelectNode?.(node.id); }}
        onEdgeClick={(_event, edge) => { if (edge.label === 'leads to') setSelectedEdgeId(edge.id); }}>
        <Background />
        <Controls />
      </ReactFlow>
    </section>
  );
}
