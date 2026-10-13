import { resolveNodeActions, type ActionOutcome, type NodeDefinition, type StableId, type WorldDocument } from '@dungeon-scrivener/model';

export type GraphCommand =
  | { readonly kind: 'add-node'; readonly node: NodeDefinition }
  | { readonly kind: 'link-nodes'; readonly edge: WorldDocument['navigationEdges'][number] }
  | { readonly kind: 'connect-scenes'; readonly edge: WorldDocument['navigationEdges'][number]; readonly actionId: StableId; readonly actionLabel: string; readonly actionKind: 'choice' | 'command' }
  | { readonly kind: 'set-action-destination'; readonly outcomeId?: StableId; readonly sourceNodeId: StableId; readonly actionKind: 'choice' | 'command'; readonly actionId: StableId; readonly toNodeId: StableId | null; readonly newEdgeId: StableId }
  | { readonly kind: 'retarget-route'; readonly edgeId: StableId; readonly toNodeId: StableId }
  | { readonly kind: 'remove-link'; readonly edgeId: StableId }
  | { readonly kind: 'reparent-node'; readonly nodeId: string; readonly parentId: string | null }
  | { readonly kind: 'delete-node'; readonly nodeId: string }
  | { readonly kind: 'delete-selection'; readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[]; readonly removeReferencedActions?: boolean }
  | { readonly kind: 'set-entry-node'; readonly nodeId: string };

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

export function referencesNavigationEdge(value: unknown, edgeIds: ReadonlySet<string>): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => referencesNavigationEdge(item, edgeIds));
  return Object.entries(value).some(([key, child]) => ((key === 'navigationEdgeId' || key === 'edgeId') && typeof child === 'string' && edgeIds.has(child))
    || referencesNavigationEdge(child, edgeIds));
}

function navigationReferencePaths(value: unknown, edgeIds: ReadonlySet<string>, path = 'world'): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => navigationReferencePaths(item, edgeIds, `${path}[${item && typeof item === 'object' && 'id' in item ? item.id : index}]`));
  return Object.entries(value).flatMap(([key, child]) => (key === 'edgeId' || key === 'navigationEdgeId') && typeof child === 'string' && edgeIds.has(child)
    ? [`${path}.${key}`] : navigationReferencePaths(child, edgeIds, `${path}.${key}`));
}

export interface GraphDeletionImpact {
  readonly routeIds: readonly string[];
  readonly actions: readonly { readonly owner: string; readonly kind: 'choice' | 'command'; readonly id: string; readonly label: string }[];
}

/** Lists surviving actions that would become invalid when selected routes are removed. */
export function previewGraphDeletion(world: WorldDocument, nodeIds: readonly string[], edgeIds: readonly string[]): GraphDeletionImpact {
  const nodes = new Set(nodeIds);
  const selectedEdges = new Set(edgeIds);
  const routes = new Set(world.navigationEdges.filter(edge => nodes.has(edge.fromNodeId) || nodes.has(edge.toNodeId) || selectedEdges.has(edge.id)).map(edge => edge.id));
  const actions: GraphDeletionImpact['actions'][number][] = [];
  const collect = (owner: string, set: NodeDefinition['actions']) => {
    for (const action of set?.choices ?? []) if (referencesNavigationEdge(action, routes)) actions.push({ owner, kind: 'choice', id: action.id, label: action.label.kind === 'literal' ? action.label.text : action.label.key });
    for (const action of set?.commands ?? []) if (referencesNavigationEdge(action, routes)) actions.push({ owner, kind: 'command', id: action.id, label: action.patterns[0] ?? action.id });
  };
  collect('Project defaults', world.actionDefaults);
  for (const node of world.nodes) if (!nodes.has(node.id)) collect(node.title.kind === 'literal' ? node.title.text : node.title.key, node.actions);
  return { routeIds: [...routes], actions };
}

function withDestination<T extends { readonly navigationEdgeId?: string; readonly outcomes?: readonly ActionOutcome[] }>(action: T, routeId: string | undefined, outcomeId?: string): T {
  const change = <U extends { readonly navigationEdgeId?: string }>(value: U): U => {
    if (routeId) return { ...value, navigationEdgeId: routeId };
    const next = { ...value };
    delete (next as { navigationEdgeId?: string }).navigationEdgeId;
    return next;
  };
  return outcomeId ? { ...action, outcomes: action.outcomes?.map(outcome => outcome.id === outcomeId ? change(outcome) : outcome) } : change(action);
}

function deleteSelection(world: WorldDocument, nodeIds: readonly string[], edgeIds: readonly string[]): GraphCommandResult {
  const nodes = new Set(nodeIds);
  const edges = new Set(edgeIds);
  if ([...nodes].some(id => !world.nodes.some(node => node.id === id))) return reject('A selected node no longer exists.');
  if (nodes.has(world.entryNodeId) && world.nodes.some(node => node.visitable && !nodes.has(node.id))) {
    return reject('The entry scene cannot be deleted while other scenes remain. Choose another start scene first.');
  }
  for (const node of world.nodes) {
    if (node.parentId && nodes.has(node.parentId) && !nodes.has(node.id)) return reject(`Move “${node.id}” out of its logic folder before deleting that folder.`);
  }
  const detached = new Set([...edges].filter(id => id.startsWith('contains:')).map(id => id.split(':').at(-1)!));
  const knownEdges = new Set(world.navigationEdges.map(edge => edge.id));
  if ([...edges].some(id => !id.startsWith('contains:') && !knownEdges.has(id))) return reject('A selected route no longer exists.');
  const impact = previewGraphDeletion(world, nodeIds, edgeIds);
  const removedEdges = new Set(impact.routeIds);
  // Detach only the direct destination. Effects and every other authored field survive.
  const pruneActions = <T extends { readonly id: string; readonly navigationEdgeId?: string; readonly outcomes?: readonly ActionOutcome[] }>(actions: readonly T[]) => actions.map(action => {
    let next = action.navigationEdgeId && removedEdges.has(action.navigationEdgeId) ? withDestination(action, undefined) : action;
    for (const outcome of action.outcomes ?? []) if (outcome.navigationEdgeId && removedEdges.has(outcome.navigationEdgeId)) next = withDestination(next, undefined, outcome.id);
    return next;
  });
  const survivingNodes = world.nodes.filter(node => !nodes.has(node.id)).map(node => {
    const parentId = detached.has(node.id) ? null : node.parentId;
    return { ...node, parentId, ...(node.actions ? { actions: {
      ...(node.actions.choices ? { choices: pruneActions(node.actions.choices) } : {}),
      ...(node.actions.commands ? { commands: pruneActions(node.actions.commands) } : {}),
    } } : {}) };
  });
  const survivingWorld = { ...world, nodes: survivingNodes,
    entryNodeId: nodes.has(world.entryNodeId) ? '' : world.entryNodeId,
    actionDefaults: { choices: pruneActions(world.actionDefaults.choices), commands: pruneActions(world.actionDefaults.commands) },
    navigationEdges: world.navigationEdges.filter(edge => !removedEdges.has(edge.id)) };
  const blocked = navigationReferencePaths({ ...survivingWorld, navigationEdges: [] }, removedEdges);
  if (blocked.length) return reject(`A surviving rule, action effect, lifecycle effect, or dialogue uses this route. Nothing changed. Repair these references first: ${blocked.join(', ')}`);
  return { ok: true, world: survivingWorld };
}

export function applyGraphCommand(world: WorldDocument, command: GraphCommand): GraphCommandResult {
  switch (command.kind) {
    case 'add-node': {
      if (world.nodes.some((node) => node.id === command.node.id)) return reject(`Node ID "${command.node.id}" already exists.`);
      if (command.node.parentId !== null && !world.nodes.some((node) => node.id === command.node.parentId)) {
        return reject(`Parent node "${command.node.parentId}" does not exist.`);
      }
      return { ok: true, world: { ...world, nodes: [...world.nodes, structuredClone(command.node)],
        entryNodeId: command.node.visitable && !world.nodes.some(node => node.visitable) ? command.node.id : world.entryNodeId } };
    }
    case 'link-nodes': {
      if (world.navigationEdges.some((edge) => edge.id === command.edge.id)) return reject(`Navigation link ID "${command.edge.id}" already exists.`);
      if (!world.nodes.some((node) => node.id === command.edge.fromNodeId) || !world.nodes.some((node) => node.id === command.edge.toNodeId)) {
        return reject('Both ends of a navigation link must refer to existing nodes.');
      }
      return { ok: true, world: { ...world, navigationEdges: [...world.navigationEdges, structuredClone(command.edge)] } };
    }
    case 'connect-scenes': {
      const source = world.nodes.find(node => node.id === command.edge.fromNodeId);
      const target = world.nodes.find(node => node.id === command.edge.toNodeId);
      if (!source?.visitable || !target?.visitable || source.id === target.id) return reject('Connect two different scenes to make a player route.');
      const existingRoute = world.navigationEdges.find(edge => edge.fromNodeId === source.id && edge.toNodeId === target.id);
      if (world.navigationEdges.some(edge => edge.id === command.edge.id && edge !== existingRoute)) return reject('The route ID is already in use.');
      const routeId = existingRoute?.id ?? command.edge.id;
      const inherited = resolveNodeActions(world, source.id).value;
      const choices = source.actions?.choices ?? inherited?.choices ?? [];
      const commands = source.actions?.commands ?? inherited?.commands ?? [];
      if ([...choices, ...commands].some(action => action.id === command.actionId)) return reject('An action with this ID already exists in the source scene.');
      const nextActions = command.actionKind === 'choice'
        ? { ...source.actions, choices: [...choices, { id: command.actionId, label: { kind: 'literal' as const, text: command.actionLabel }, navigationEdgeId: routeId, effects: [] }] }
        : { ...source.actions, commands: [...commands, { id: command.actionId, patterns: [command.actionLabel], parameters: [], navigationEdgeId: routeId, effects: [] }] };
      const nextSource = { ...source, actions: nextActions };
      return { ok: true, world: { ...world, nodes: world.nodes.map(node => node.id === source.id ? nextSource : node), navigationEdges: existingRoute ? world.navigationEdges : [...world.navigationEdges, structuredClone(command.edge)] } };
    }
    case 'set-action-destination': {
      const source = world.nodes.find(node => node.id === command.sourceNodeId);
      if (!source?.visitable) return reject('Select a scene before assigning a destination.');
      const key = command.actionKind === 'choice' ? 'choices' : 'commands';
      const actions = source.actions?.[key] ?? resolveNodeActions(world, source.id).value?.[key];
      if (!actions?.some(action => action.id === command.actionId)) return reject('The selected player action no longer exists.');
      const selectedAction = actions.find(action => action.id === command.actionId)!;
      if (command.outcomeId && !selectedAction.outcomes?.some(outcome => outcome.id === command.outcomeId)) return reject('The selected conditional outcome no longer exists.');
      const target = command.toNodeId ? world.nodes.find(node => node.id === command.toNodeId) : undefined;
      if (command.toNodeId && (!target?.visitable || target.id === source.id)) return reject('Choose another playable scene as the destination.');
      const existing = target && world.navigationEdges.find(edge => edge.fromNodeId === source.id && edge.toNodeId === target.id);
      if (target && !existing && world.navigationEdges.some(edge => edge.id === command.newEdgeId)) return reject('The new route ID already exists.');
      const routeId = existing?.id ?? (target ? command.newEdgeId : undefined);
      const updated = actions.map(action => {
        if (action.id !== command.actionId) return action;
        return withDestination(action, routeId, command.outcomeId);
      });
      const nextSource = { ...source, actions: { ...source.actions, [key]: updated } };
      let nextWorld: WorldDocument = { ...world, nodes: world.nodes.map(node => node.id === source.id ? nextSource : node), navigationEdges: target && !existing ? [...world.navigationEdges, { id: command.newEdgeId, fromNodeId: source.id, toNodeId: target.id }] : world.navigationEdges };
      const oldRouteId = command.outcomeId ? selectedAction.outcomes?.find(outcome => outcome.id === command.outcomeId)?.navigationEdgeId : selectedAction.navigationEdgeId;
      if (oldRouteId && oldRouteId !== routeId && !referencesNavigationEdge({ ...nextWorld, navigationEdges: [] }, new Set([oldRouteId]))) {
        // A sole route keeps its identity when redirected. Shared/advanced routes remain intact.
        const oldRoute = world.navigationEdges.find(edge => edge.id === oldRouteId && edge.fromNodeId === source.id);
        if (target && !existing && oldRoute) {
          const rebound = updated.map(action => action.id === command.actionId ? withDestination(action, oldRouteId, command.outcomeId) : action);
          nextWorld = { ...nextWorld, nodes: nextWorld.nodes.map(node => node.id === source.id ? { ...node, actions: { ...node.actions, [key]: rebound } } : node),
            navigationEdges: world.navigationEdges.map(edge => edge.id === oldRouteId ? { ...edge, toNodeId: target.id } : edge) };
        } else nextWorld = { ...nextWorld, navigationEdges: nextWorld.navigationEdges.filter(edge => edge.id !== oldRouteId) };
      }
      return { ok: true, world: nextWorld };
    }
    case 'retarget-route': {
      const edge = world.navigationEdges.find(item => item.id === command.edgeId);
      if (!edge) return reject('This route no longer exists.');
      const target = world.nodes.find(node => node.id === command.toNodeId);
      if (!target?.visitable || target.id === edge.fromNodeId) return reject('Choose a different playable scene. The original route is unchanged.');
      if (world.navigationEdges.some(item => item.id !== edge.id && item.fromNodeId === edge.fromNodeId && item.toNodeId === target.id)) {
        return reject('A route to that scene already exists. Change this action’s destination to that scene to reuse it; shared routes are not merged automatically.');
      }
      return { ok: true, world: { ...world, navigationEdges: world.navigationEdges.map(item => item.id === edge.id ? { ...item, toNodeId: target.id } : item) } };
    }
    case 'remove-link': {
      if (!world.navigationEdges.some((edge) => edge.id === command.edgeId)) return reject(`Navigation link "${command.edgeId}" does not exist.`);
      return deleteSelection(world, [], [command.edgeId]);
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
    case 'delete-selection': return deleteSelection(world, command.nodeIds, command.edgeIds);
    case 'set-entry-node': {
      const node = world.nodes.find(candidate => candidate.id === command.nodeId);
      if (!node?.visitable) return reject('Choose an existing scene as the start scene.');
      return { ok: true, world: { ...world, entryNodeId: command.nodeId } };
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
