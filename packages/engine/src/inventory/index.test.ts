import { describe, expect, it } from 'vitest';
import type { Condition, SessionSnapshot, WorldDocument } from '@dungeon-scrivener/model';
import tavernWorldJson from '../../../../fixtures/tavern-at-dusk/world.json';
import { dispatchPlayerInput } from '../core/actions.js';
import { createInitialState } from '../core/state.js';
import { applyInventoryEffect, inventoryOperationEffect } from './index.js';

const baseWorld = tavernWorldJson as unknown as WorldDocument;
const owner = { kind: 'world' } as const;

function worldWithInventory(): WorldDocument {
  return {
    ...baseWorld,
    itemDefinitions: [
      { id: 'pouch', name: { kind: 'literal', text: 'Pouch' }, stackLimit: 1, canContain: true, fields: [] },
      { id: 'box', name: { kind: 'literal', text: 'Box' }, stackLimit: 1, canContain: true, fields: [] },
      { id: 'coin', name: { kind: 'literal', text: 'Coin' }, stackLimit: 10, canContain: false, fields: [{ key: 'quality', valueType: 'integer', defaultValue: 1 }] },
      { id: 'silver-ring', name: { kind: 'literal', text: 'Silver ring' }, stackLimit: 1, canContain: false, useEventId: 'use-item', equipmentSlot: 'finger', fields: [] },
    ],
    eventDefinitions: [
      ...baseWorld.eventDefinitions.filter((event) => event.id !== 'use-item'),
      { id: 'use-item', payloadFields: [
        { key: 'stackId', valueType: 'string', defaultValue: '' },
        { key: 'itemId', valueType: 'string', defaultValue: '' },
        { key: 'quantity', valueType: 'number', defaultValue: 0 },
      ] },
    ],
    initialInventory: [
      { id: 'stack-0', owner, itemId: 'pouch', quantity: 1, fields: {} },
      { id: 'stack-1', owner, itemId: 'coin', quantity: 3, fields: { quality: 4 } },
      { id: 'stack-2', owner, itemId: 'silver-ring', quantity: 1, fields: {} },
    ],
  };
}

function snapshotFor(world: WorldDocument): SessionSnapshot {
  return {
    projectId: 'tavern-at-dusk', currentNodeId: world.entryNodeId, state: createInitialState(world),
    nodeVisitCounts: Object.fromEntries(world.nodes.map((node) => [node.id, 0])), conversationStack: [], dialogueHistory: [],
    gameTimeMilliseconds: 0, randomnessMode: 'seeded', randomInitialSeed: 1, randomSeed: 1,
    randomOutcomes: [], entityTags: Object.fromEntries(world.entities.map((entity) => [entity.id, [...entity.tags]])),
    clockState: { visibility: 'visible', focused: true, lastObservedEpochMilliseconds: null, inactiveSinceEpochMilliseconds: null },
    ruleGuards: {}, inventory: world.initialInventory, nextInventoryStackOrdinal: 3,
  };
}

describe('inventory primitives', () => {
  it('transfers a quantity into a nested container and preserves custom fields', () => {
    const world = worldWithInventory();
    const original = snapshotFor(world);
    const moved = dispatchPlayerInput(world, original, { kind: 'inventory', operation: {
      kind: 'transfer', stackId: 'stack-1', quantity: 2, destination: { owner, containerStackId: 'stack-0' },
    } });
    expect(moved.resolution.kind).toBe('inventory');
    expect(original.inventory.find((stack) => stack.id === 'stack-1')?.quantity).toBe(3);
    expect(moved.snapshot.inventory).toContainEqual(expect.objectContaining({ id: 'stack-1', itemId: 'coin', quantity: 1, fields: { quality: 4 } }));
    expect(moved.snapshot.inventory).toContainEqual(expect.objectContaining({ id: 'stack-3', itemId: 'coin', quantity: 2, containerStackId: 'stack-0', fields: { quality: 4 } }));
  });

  it('dispatches item use through the event queue and does not consume the stack', () => {
    const base = worldWithInventory();
    const world: WorldDocument = {
      ...base,
      eventDefinitions: [...base.eventDefinitions, { id: 'ring-used', payloadFields: [
        { key: 'stackId', valueType: 'string', defaultValue: '' },
        { key: 'itemId', valueType: 'string', defaultValue: '' },
        { key: 'quantity', valueType: 'number', defaultValue: 0 },
      ] }],
      itemDefinitions: base.itemDefinitions.map((item) => item.id === 'silver-ring' ? { ...item, useEventId: 'ring-used' } : item),
      nodes: base.nodes.map((node) => node.id === base.entryNodeId ? { ...node, ruleIds: ['on-ring-use'] } : node),
      rules: [{ id: 'on-ring-use', trigger: { kind: 'event', eventId: 'ring-used' }, priority: 1,
        effects: [{ kind: 'add-item', owner, itemId: 'coin', quantity: 1, fields: { quality: 7 } }] }],
    };
    const original = snapshotFor(world);
    const used = dispatchPlayerInput(world, original, { kind: 'inventory', operation: { kind: 'use', stackId: 'stack-2' } });
    expect(used.resolution.kind).toBe('inventory');
    expect(used.snapshot.inventory.find((stack) => stack.id === 'stack-2')?.quantity).toBe(1);
    expect(used.snapshot.inventory).toContainEqual(expect.objectContaining({ id: 'stack-3', itemId: 'coin', quantity: 1, fields: { quality: 7 } }));
    expect(used.trace.some((record) => record.kind === 'event' && record.eventId === 'ring-used')).toBe(true);
  });

  it('rejects a forbidden container cycle by stack identity', () => {
    const world = worldWithInventory();
    const nestedSnapshot = { ...snapshotFor(world), inventory: [
      { id: 'stack-0', owner, itemId: 'box', quantity: 1, fields: {} },
      { id: 'stack-1', owner, itemId: 'pouch', quantity: 1, containerStackId: 'stack-0', fields: {} },
      { id: 'stack-2', owner, itemId: 'coin', quantity: 1, containerStackId: 'stack-1', fields: { quality: 4 } },
    ] };
    const moved = applyInventoryEffect(world, nestedSnapshot, { kind: 'transfer-item', stackId: 'stack-0', quantity: 1, destination: { owner, containerStackId: 'stack-1' } });
    expect(moved.ok).toBe(false);
    expect(moved.snapshot).toBe(nestedSnapshot);
  });

  it('supports an explicitly declared equipment slot', () => {
    const world = worldWithInventory();
    const original = snapshotFor(world);
    const equipEffect = inventoryOperationEffect({ kind: 'equip', stackId: 'stack-2', slotId: 'finger' });
    expect(equipEffect).toBeDefined();
    const equipped = applyInventoryEffect(world, original, equipEffect!);
    expect(equipped.ok).toBe(true);
    expect(equipped.snapshot.inventory.find((stack) => stack.id === 'stack-2')?.equippedSlot).toBe('finger');
    const unequipEffect = inventoryOperationEffect({ kind: 'unequip', stackId: 'stack-2', slotId: 'finger' });
    expect(unequipEffect).toBeDefined();
    const unequipped = applyInventoryEffect(world, equipped.snapshot, unequipEffect!);
    expect(unequipped.snapshot.inventory.find((stack) => stack.id === 'stack-2')?.equippedSlot).toBeUndefined();
    expect(applyInventoryEffect(world, original, { kind: 'equip-item', stackId: 'stack-1', slotId: 'finger' }).ok).toBe(false);
  });

  it('applies custom item fields and rejects unknown items and quantity underflow atomically', () => {
    const world = worldWithInventory();
    const original = snapshotFor(world);
    const added = applyInventoryEffect(world, original, { kind: 'add-item', owner, itemId: 'coin', quantity: 1 });
    expect(added.ok).toBe(true);
    expect(added.snapshot.inventory).toContainEqual(expect.objectContaining({ id: 'stack-3', itemId: 'coin', quantity: 1, fields: { quality: 1 } }));

    const unknown = applyInventoryEffect(world, original, { kind: 'add-item', owner, itemId: 'missing', quantity: 1 });
    expect(unknown.ok).toBe(false);
    const underflow = applyInventoryEffect(world, original, { kind: 'remove-item', stackId: 'stack-1', quantity: 4 });
    expect(underflow.ok).toBe(false);
    expect(underflow.snapshot).toBe(original);
    const negativeStock = applyInventoryEffect(world, original, { kind: 'add-item', owner, itemId: 'coin', quantity: -1 });
    expect(negativeStock.ok).toBe(false);
  });

  it('runs choice and rule inventory effects provisionally and rolls them back on a later failure', () => {
    const base = worldWithInventory();
    const choice = {
      id: 'claim-box', label: { kind: 'literal' as const, text: 'Claim box' },
      effects: [
        { kind: 'add-item' as const, owner, itemId: 'box', quantity: 1 },
        { kind: 'emit-event' as const, eventId: 'item-added', payload: {} },
      ],
    };
    const hasNewItem: Condition = { kind: 'has-item', owner, itemId: 'box', quantity: 1 };
    const common: WorldDocument = {
      ...base,
      settings: { ...base.settings, time: { ...base.settings.time, mode: 'per-action' as const, millisecondsPerAction: 1000 } },
      eventDefinitions: [...base.eventDefinitions, { id: 'item-added', payloadFields: [] }],
      nodes: base.nodes.map((node) => node.id === base.entryNodeId
        ? { ...node, ruleIds: ['add-coin', 'fail-later'], actions: { choices: [choice], commands: [] } }
        : node),
      rules: [
        { id: 'add-coin', trigger: { kind: 'event' as const, eventId: 'item-added' }, priority: 2, condition: hasNewItem,
          effects: [{ kind: 'add-item' as const, owner, itemId: 'coin', quantity: 1, fields: { quality: 8 } }] },
        { id: 'fail-later', trigger: { kind: 'event' as const, eventId: 'item-added' }, priority: 1, condition: hasNewItem,
          effects: [
            { kind: 'add-item' as const, owner, itemId: 'coin', quantity: 1 },
            { kind: 'increment-state' as const, target: { scope: { kind: 'world' as const }, key: 'missing-state' }, amount: 1 },
          ] },
      ],
    };
    const original = snapshotFor(common);
    const failed = dispatchPlayerInput(common, original, { kind: 'choice', actionId: 'claim-box' });
    expect(failed.diagnostics.diagnostics.length).toBeGreaterThan(0);
    expect(failed.snapshot).toBe(original);
    expect(failed.snapshot.inventory).toEqual(original.inventory);
    expect(failed.snapshot.gameTimeMilliseconds).toBe(0);
    expect(failed.snapshot.nextInventoryStackOrdinal).toBe(3);

    const success: WorldDocument = { ...common, rules: common.rules.slice(0, 1) };
    const accepted = dispatchPlayerInput(success, original, { kind: 'choice', actionId: 'claim-box' });
    expect(accepted.snapshot.inventory).toContainEqual(expect.objectContaining({ id: 'stack-3', itemId: 'box', quantity: 1 }));
    expect(accepted.snapshot.inventory).toContainEqual(expect.objectContaining({ id: 'stack-4', itemId: 'coin', fields: { quality: 8 } }));
  });
});
