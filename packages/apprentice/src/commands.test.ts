import { describe, expect, it } from 'vitest';
import linearWorldJson from '../../../fixtures/linear-three-nodes/world.json';
import type { WorldDocument } from '@dungeon-scrivener/model';
import { createGraphHistory, dispatchGraphCommand, previewGraphDeletion, redoGraphEdit, undoGraphEdit } from './commands.js';

const fixture = () => structuredClone(linearWorldJson) as WorldDocument;

describe('Apprentice graph commands', () => {
  it('reparents a node without changing navigation', () => {
    const world = fixture();
    const edgesBefore = world.navigationEdges;
    const result = dispatchGraphCommand(createGraphHistory(world), { kind: 'reparent-node', nodeId: 'stone-bridge', parentId: 'lantern-house' });
    expect(result.result.ok).toBe(true);
    expect(result.history.world.nodes.find((node) => node.id === 'stone-bridge')?.parentId).toBe('lantern-house');
    expect(result.history.world.navigationEdges).toEqual(edgesBefore);
  });

  it('removes a navigation link without deleting either endpoint', () => {
    const world = { ...fixture(), navigationEdges: [...fixture().navigationEdges, { id: 'unused-route', fromNodeId: 'old-gate', toNodeId: 'lantern-house' }] };
    const result = dispatchGraphCommand(createGraphHistory(world), { kind: 'remove-link', edgeId: 'unused-route' });
    expect(result.result.ok).toBe(true);
    expect(result.history.world.navigationEdges.some((edge) => edge.id === 'unused-route')).toBe(false);
    expect(result.history.world.nodes.map((node) => node.id)).toEqual(world.nodes.map((node) => node.id));
  });

  it('undoes and redoes graph edits without changing stable node IDs', () => {
    const world = fixture();
    const ids = world.nodes.map((node) => node.id);
    const changed = dispatchGraphCommand(createGraphHistory(world), { kind: 'reparent-node', nodeId: 'stone-bridge', parentId: 'lantern-house' }).history;
    const undone = undoGraphEdit(changed);
    expect(undone.world.nodes.find((node) => node.id === 'stone-bridge')?.parentId).toBeNull();
    expect(undone.world.nodes.map((node) => node.id)).toEqual(ids);
    const redone = redoGraphEdit(undone);
    expect(redone.world.nodes.find((node) => node.id === 'stone-bridge')?.parentId).toBe('lantern-house');
    expect(redone.world.nodes.map((node) => node.id)).toEqual(ids);
  });

  it('refuses a containment cycle with a specific message', () => {
    const rooted = dispatchGraphCommand(createGraphHistory(fixture()), { kind: 'reparent-node', nodeId: 'lantern-house', parentId: 'old-gate' });
    expect(rooted.result.ok).toBe(true);
    const result = dispatchGraphCommand(rooted.history, { kind: 'reparent-node', nodeId: 'old-gate', parentId: 'lantern-house' });
    expect(result.result).toEqual({ ok: false, message: 'Cannot reparent this node because it would create a containment cycle.' });
    expect(result.history.world.nodes.find((node) => node.id === 'old-gate')?.parentId).toBeNull();
  });

  it('deletes a selected scene while preserving external choices', () => {
    const world = fixture();
    const result = dispatchGraphCommand(createGraphHistory(world), { kind: 'delete-selection', nodeIds: ['lantern-house'], edgeIds: [] });
    expect(result.result.ok).toBe(true);
    const detached = { ...world, nodes: world.nodes.map(node => node.id === 'stone-bridge' ? { ...node, actions: { choices: [] } } : node) };
    const successful = dispatchGraphCommand(createGraphHistory(detached), { kind: 'delete-selection', nodeIds: ['lantern-house'], edgeIds: [] });
    expect(successful.result.ok).toBe(true);
    expect(successful.history.world.nodes.some(node => node.id === 'lantern-house')).toBe(false);
    expect(successful.history.world.navigationEdges.some(edge => edge.toNodeId === 'lantern-house')).toBe(false);
  });

  it('previews dependent choices and detaches them in one undo step', () => {
    const world = fixture();
    const impact = previewGraphDeletion(world, ['stone-bridge'], []);
    expect(impact.routeIds).toEqual(['gate-to-bridge', 'bridge-to-home']);
    expect(impact.actions).toMatchObject([{ kind: 'choice', id: 'open-gate' }]);
    const deleted = dispatchGraphCommand(createGraphHistory(world), { kind: 'delete-selection', nodeIds: ['stone-bridge'], edgeIds: [], removeReferencedActions: true });
    expect(deleted.result.ok).toBe(true);
    expect(deleted.history.world.nodes.some(node => node.id === 'stone-bridge')).toBe(false);
    const { navigationEdgeId: _route, ...retainedChoice } = world.nodes.find(node => node.id === 'old-gate')!.actions!.choices![0]!;
    expect(deleted.history.world.nodes.find(node => node.id === 'old-gate')?.actions?.choices).toEqual([retainedChoice]);
    expect(deleted.history.world.navigationEdges).toEqual([]);
    expect(undoGraphEdit(deleted.history).world).toBe(world);
  });

  it('lets an author choose another start scene before removing the old one', () => {
    const world = fixture();
    const changed = dispatchGraphCommand(createGraphHistory(world), { kind: 'set-entry-node', nodeId: 'stone-bridge' });
    expect(changed.result.ok).toBe(true);
    expect(changed.history.world.entryNodeId).toBe('stone-bridge');
    const removed = dispatchGraphCommand(changed.history, { kind: 'delete-selection', nodeIds: ['old-gate'], edgeIds: [], removeReferencedActions: true });
    expect(removed.result.ok).toBe(true);
    expect(removed.history.world.nodes.some(node => node.id === 'old-gate')).toBe(false);
  });

  it('keeps rules that refer to deleted routes protected', () => {
    const world = fixture();
    const withRule: WorldDocument = { ...world, rules: [{ id: 'travel-rule', trigger: { kind: 'phase', phase: 'node-entry' }, priority: 1, effects: [{ kind: 'navigate', edgeId: 'gate-to-bridge' }] }] };
    const result = dispatchGraphCommand(createGraphHistory(withRule), { kind: 'delete-selection', nodeIds: ['stone-bridge'], edgeIds: [], removeReferencedActions: true });
    expect(result.result).toMatchObject({ ok: false, message: expect.stringContaining('surviving rule') });
    expect(result.history.world).toBe(withRule);
  });

  it('blocks atomic deletion of the entry scene', () => {
    const world = fixture();
    const result = dispatchGraphCommand(createGraphHistory(world), { kind: 'delete-selection', nodeIds: ['old-gate', 'stone-bridge'], edgeIds: [] });
    expect(result.result.ok).toBe(false);
    expect(result.history.world).toBe(world);
  });

  it('lets an author clear every starter scene and makes the next scene the start', () => {
    const world = fixture();
    const cleared = dispatchGraphCommand(createGraphHistory(world), { kind: 'delete-selection', nodeIds: world.nodes.map(node => node.id), edgeIds: [], removeReferencedActions: true });
    expect(cleared.result.ok).toBe(true);
    expect(cleared.history.world.nodes).toEqual([]);
    expect(cleared.history.world.navigationEdges).toEqual([]);
    expect(cleared.history.world.entryNodeId).toBe('');
    const next = dispatchGraphCommand(cleared.history, { kind: 'add-node', node: {
      id: 'new-start', parentId: null, visitable: true, title: { kind: 'literal', text: 'New start' }, content: { kind: 'literal', text: '' },
    } });
    expect(next.result.ok).toBe(true);
    expect(next.history.world.entryNodeId).toBe('new-start');
  });
});
