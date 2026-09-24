import { describe, expect, it } from 'vitest';
import linearWorldJson from '../../../fixtures/linear-three-nodes/world.json';
import type { WorldDocument } from '@dungeon-scrivener/model';
import { createGraphHistory, dispatchGraphCommand, redoGraphEdit, undoGraphEdit } from './commands.js';

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
    const world = fixture();
    const result = dispatchGraphCommand(createGraphHistory(world), { kind: 'remove-link', edgeId: 'gate-to-bridge' });
    expect(result.result.ok).toBe(true);
    expect(result.history.world.navigationEdges.some((edge) => edge.id === 'gate-to-bridge')).toBe(false);
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
});
