import type { NodeDefinition, StableId, WorldDocument } from '@dungeon-scrivener/model';

export type GraphCommand =
  | { readonly kind: 'add-node'; readonly node: NodeDefinition }
  | { readonly kind: 'link-nodes'; readonly edge: WorldDocument['navigationEdges'][number] }
  | { readonly kind: 'remove-link'; readonly edgeId: StableId }
  | { readonly kind: 'reparent-node'; readonly nodeId: string; readonly parentId: string | null }
  | { readonly kind: 'delete-node'; readonly nodeId: string };

export type GraphCommandResult =
  | { readonly ok: true; readonly world: WorldDocument }
  | { readonly ok: false; readonly message: string };

const reject = (message: string): GraphCommandResult => ({ ok: false, message });

/** Replace one edited node while retaining all other node objects and document fields. */
export function updateNodeDefinition(
  world: WorldDocument,
  nodeId: string,
  update: (node: NodeDefinition) => NodeDefinition,
): WorldDocument | undefined {
  let found = false;
  const nodes = world.nodes.map((node) => {
    if (node.id !== nodeId) return node;
    found = true;
    return update(node);
  });
  return found ? { ...world, nodes } : undefined;
}

function hasContainmentCycle(nodes: readonly NodeDefinition[]): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const ancestors = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) return true;
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
  return false;
}

export function applyGraphCommand(world: WorldDocument, command: GraphCommand): GraphCommandResult {
  switch (command.kind) {
    case 'add-node': {
      if (world.nodes.some((node) => node.id === command.node.id)) return reject(`Node ID "${command.node.id}" already exists.`);
      if (command.node.parentId !== null && !world.nodes.some((node) => node.id === command.node.parentId)) {
        return reject(`Parent node "${command.node.parentId}" does not exist.`);
      }
      return { ok: true, world: { ...world, nodes: [...world.nodes, structuredClone(command.node)] } };
    }
    case 'link-nodes': {
      if (world.navigationEdges.some((edge) => edge.id === command.edge.id)) return reject(`Navigation link ID "${command.edge.id}" already exists.`);
      if (!world.nodes.some((node) => node.id === command.edge.fromNodeId) || !world.nodes.some((node) => node.id === command.edge.toNodeId)) {
        return reject('Both ends of a navigation link must refer to existing nodes.');
      }
      return { ok: true, world: { ...world, navigationEdges: [...world.navigationEdges, structuredClone(command.edge)] } };
    }
    case 'remove-link': {
      if (!world.navigationEdges.some((edge) => edge.id === command.edgeId)) return reject(`Navigation link "${command.edgeId}" does not exist.`);
      return { ok: true, world: { ...world, navigationEdges: world.navigationEdges.filter((edge) => edge.id !== command.edgeId) } };
    }
    case 'reparent-node': {
      if (command.nodeId === command.parentId) return reject('A node cannot contain itself.');
      if (!world.nodes.some((node) => node.id === command.nodeId)) return reject(`Node "${command.nodeId}" does not exist.`);
      if (command.parentId !== null && !world.nodes.some((node) => node.id === command.parentId)) return reject(`Parent node "${command.parentId}" does not exist.`);
      const nodes = world.nodes.map((node) => node.id === command.nodeId ? { ...node, parentId: command.parentId } : node);
      if (hasContainmentCycle(nodes)) return reject('Cannot reparent this node because it would create a containment cycle.');
      return { ok: true, world: { ...world, nodes } };
    }
    case 'delete-node': {
      const node = world.nodes.find((candidate) => candidate.id === command.nodeId);
      if (!node) return reject(`Node "${command.nodeId}" does not exist.`);
      if (node.parentId !== null || world.nodes.some((candidate) => candidate.parentId === node.id)) {
        return reject('Move this node and its contained children before deleting it.');
      }
      if (world.entryNodeId === node.id) return reject('The entry node cannot be deleted. Choose another entry node first.');
      if (world.navigationEdges.some((edge) => edge.fromNodeId === node.id || edge.toNodeId === node.id)) {
        return reject('Remove this node’s navigation links before deleting it.');
      }
      return { ok: true, world: { ...world, nodes: world.nodes.filter((candidate) => candidate.id !== node.id) } };
    }
  }
}

export interface GraphHistory {
  readonly world: WorldDocument;
  readonly past: readonly WorldDocument[];
  readonly future: readonly WorldDocument[];
}

export function createGraphHistory(world: WorldDocument): GraphHistory {
  return { world, past: [], future: [] };
}

export function dispatchGraphCommand(history: GraphHistory, command: GraphCommand): { readonly history: GraphHistory; readonly result: GraphCommandResult } {
  const result = applyGraphCommand(history.world, command);
  if (!result.ok) return { history, result };
  return {
    history: { world: result.world, past: [...history.past, history.world], future: [] },
    result,
  };
}

export function undoGraphEdit(history: GraphHistory): GraphHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return { world: previous, past: history.past.slice(0, -1), future: [history.world, ...history.future] };
}

export function redoGraphEdit(history: GraphHistory): GraphHistory {
  const next = history.future[0];
  if (!next) return history;
  return { world: next, past: [...history.past, history.world], future: history.future.slice(1) };
}
