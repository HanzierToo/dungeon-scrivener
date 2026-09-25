import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, ReactFlow, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorldDocument } from '@dungeon-scrivener/model';
import { createGraphHistory, dispatchGraphCommand, redoGraphEdit, undoGraphEdit, type GraphHistory } from './commands.js';
import { projectGraph } from './graph.js';

export interface ApprenticeGraphProps {
  readonly world: WorldDocument;
  readonly nodeLabels?: Readonly<Record<string, string>>;
  readonly selectedNodeId?: string;
  readonly onSelectNode?: (nodeId: string) => void;
  readonly onWorldChange?: (world: WorldDocument) => void;
}

/** Read-only graph projection. All mutations must be dispatched through structured graph commands. */
export function ApprenticeGraph({ world, nodeLabels, selectedNodeId, onSelectNode, onWorldChange }: ApprenticeGraphProps) {
  const [history, setHistory] = useState<GraphHistory>(() => createGraphHistory(world));
  const [activeNodeId, setActiveNodeId] = useState(selectedNodeId ?? '');
  const [message, setMessage] = useState('');
  const [canvasWidth, setCanvasWidth] = useState(0);
  const lastEmittedWorld = useRef<string | null>(null);
  const lastWorld = useRef(JSON.stringify(world));
  const graphElement = useRef<HTMLElement>(null);
  const flowInstance = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  useEffect(() => {
    const element = graphElement.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setCanvasWidth(element.clientWidth));
    observer.observe(element);
    setCanvasWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
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
  const columns = canvasWidth < 600 ? 1 : canvasWidth < 950 ? 2 : 4;
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void flowInstance.current?.fitView({ padding: 0.16, duration: 0 }); });
    return () => window.cancelAnimationFrame(frame);
  }, [columns, graph.nodes.length]);
  const nodes: Node[] = graph.nodes.map((node, index) => ({
    id: node.id,
    position: { x: (index % columns) * 230, y: Math.floor(index / columns) * 130 },
    data: { label: `${node.visitable ? 'Scene' : 'Folder'}: ${nodeLabels?.[node.id] ?? node.title}` },
    selected: node.id === (selectedNodeId ?? activeNodeId),
    style: { borderRadius: node.visitable ? 8 : 3, border: node.visitable ? '2px solid #365b78' : '2px dashed #777', padding: 10 },
  }));
  const edges: Edge[] = [
    ...graph.containment.map((edge) => ({ id: edge.id, source: edge.parentId, target: edge.childId, label: 'contains', type: 'step', style: { stroke: '#777', strokeDasharray: '5 4' }, labelStyle: { fill: '#555' }, selectable: false })),
    ...graph.navigation.map((edge) => ({ id: edge.id, source: edge.fromNodeId, target: edge.toNodeId, label: 'leads to', type: 'default', markerEnd: { type: 'arrowclosed' as const }, style: { stroke: '#26734d' }, labelStyle: { fill: '#26734d' } })),
  ];

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
    const id = crypto.randomUUID();
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
      <div role="toolbar" aria-label="Graph editing" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8 }}>
        <button type="button" onClick={() => createNode(true)}>Add scene</button>
        <button type="button" onClick={() => createNode(false)}>Add folder</button>
        <button type="button" disabled={!history.past.length} onClick={undo}>Undo</button>
        <button type="button" disabled={!history.future.length} onClick={redo}>Redo</button>
        <label>
          Move selected node under
          <select aria-label="Containment parent" value={selectedNode?.parentId ?? ''} disabled={!selectedNode} onChange={(event) => dispatch({ kind: 'reparent-node', nodeId: activeNodeId, parentId: event.target.value || null })}>
            <option value="">No parent</option>
            {nodeIds.filter((id) => id !== activeNodeId).map((id) => <option key={id} value={id}>{nodeLabels?.[id] ?? graph.nodes.find((node) => node.id === id)?.title ?? id}</option>)}
          </select>
        </label>
        <button type="button" disabled={!selectedNode || activeNodeId === editableWorld.entryNodeId} onClick={() => dispatch({ kind: 'delete-node', nodeId: activeNodeId })}>Delete selected</button>
        <label>
          Link selected scene to
          <select aria-label="Navigation destination" value="" disabled={!selectedNode?.visitable} onChange={(event) => {
            const toNodeId = event.target.value;
            if (toNodeId) dispatch({ kind: 'link-nodes', edge: { id: crypto.randomUUID(), fromNodeId: activeNodeId, toNodeId } });
          }}>
            <option value="">Choose destination</option>
            {graph.nodes.filter((node) => node.visitable && node.id !== activeNodeId).map((node) => <option key={node.id} value={node.id}>{nodeLabels?.[node.id] ?? node.title}</option>)}
          </select>
        </label>
      </div>
      {message && <p role="alert">{message}</p>}
      <div aria-label="Relationship legend" style={{ display: 'flex', gap: 16, padding: 8, fontSize: 13 }}>
        <span>Dashed grey line: containment</span>
        <span>Solid green arrow: player navigation</span>
      </div>
      <ReactFlow nodes={nodes} edges={edges} fitView onInit={instance => { flowInstance.current = instance; }} onNodeClick={(_event, node) => { setActiveNodeId(node.id); onSelectNode?.(node.id); }} onEdgeClick={(_event, edge) => {
        if (edge.label === 'leads to') dispatch({ kind: 'remove-link', edgeId: edge.id });
      }}>
        <Background />
        <Controls />
      </ReactFlow>
    </section>
  );
}
