import type {
  Diagnostic, Effect, EventOccurrence, InventoryLocation, InventoryPlayerOperation, InventoryStack,
  InventoryStackId, ItemDefinition, ItemId, Scalar, ScalarRecord, SessionSnapshot, StateScope, WorldDocument,
} from '@dungeon-scrivener/model';

const INVALID_INVENTORY = 'DS-ENG-020';
const MAX_INVENTORY_STACKS = 10_000;
const MAX_NEXT_STACK_ORDINAL = 1_000_000;

export interface InventoryOperationResult {
  readonly ok: boolean;
  readonly snapshot: SessionSnapshot;
  readonly diagnostics: readonly Diagnostic[];
  readonly event?: EventOccurrence;
}

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function failure(snapshot: SessionSnapshot, message: string): InventoryOperationResult {
  return { ok: false, snapshot, diagnostics: [{ code: INVALID_INVENTORY, severity: 'error', message, blocks: ['play'] }] };
}

function sameOwner(left: StateScope, right: StateScope): boolean {
  return left.kind === right.kind && (left.kind === 'world' || ('ownerId' in right && left.ownerId === right.ownerId));
}

function validOwner(world: WorldDocument, owner: StateScope): boolean {
  if (typeof owner !== 'object' || owner === null) return false;
  if (owner.kind === 'world') return true;
  if (owner.kind === 'node') return world.nodes.some((node) => node.id === owner.ownerId);
  if (owner.kind === 'entity') return world.entities.some((entity) => entity.id === owner.ownerId);
  return false;
}

function definition(world: WorldDocument, itemId: ItemId): ItemDefinition | undefined {
  return world.itemDefinitions.find((item) => item.id === itemId);
}

function validFields(item: ItemDefinition, fields: ScalarRecord): boolean {
  const declared = new Map(item.fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(fields)) {
    const field = declared.get(key);
    if (!field) return false;
    if (typeof field.valueType === 'string') {
      if (field.valueType === 'string' && typeof value !== 'string') return false;
      if (field.valueType === 'boolean' && typeof value !== 'boolean') return false;
      if (field.valueType === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false;
      if (field.valueType === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value))) return false;
    } else if (typeof value !== 'string' || !field.valueType.values.includes(value)) return false;
  }
  return true;
}

function defaultFields(item: ItemDefinition): ScalarRecord {
  return Object.fromEntries(item.fields.map((field) => [field.key, field.defaultValue]));
}

function fieldsWithDefaults(item: ItemDefinition, provided: ScalarRecord = {}): ScalarRecord | undefined {
  const fields = { ...defaultFields(item), ...provided };
  return validFields(item, fields) ? fields : undefined;
}

function ownerName(owner: StateScope): string {
  if (!owner || typeof owner !== 'object') return 'unknown';
  return owner.kind === 'world' ? 'world' : `${owner.kind}:${'ownerId' in owner ? owner.ownerId : 'unknown'}`;
}

function stackById(snapshot: SessionSnapshot, stackId: InventoryStackId): InventoryStack | undefined {
  return snapshot.inventory.find((stack) => stack.id === stackId);
}

function stackDefinition(world: WorldDocument, stack: InventoryStack): ItemDefinition | undefined {
  return definition(world, stack.itemId);
}

function nextStackId(snapshot: SessionSnapshot, stacks: readonly InventoryStack[]): { readonly id: InventoryStackId; readonly next: number } | undefined {
  let ordinal = snapshot.nextInventoryStackOrdinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > MAX_NEXT_STACK_ORDINAL) return undefined;
  const ids = new Set(stacks.map((stack) => stack.id));
  while (ordinal < MAX_NEXT_STACK_ORDINAL) {
    const id = `stack-${ordinal}`;
    ordinal += 1;
    if (!ids.has(id)) return { id, next: ordinal };
  }
  return undefined;
}

function childStacks(stacks: readonly InventoryStack[], parentId: InventoryStackId): InventoryStack[] {
  return stacks.filter((stack) => stack.containerStackId === parentId);
}

function isDescendant(stacks: readonly InventoryStack[], ancestorId: InventoryStackId, candidateId: InventoryStackId): boolean {
  let current: InventoryStackId | undefined = candidateId;
  const visited = new Set<InventoryStackId>();
  while (current) {
    if (current === ancestorId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = stacks.find((stack) => stack.id === current)?.containerStackId;
  }
  return false;
}

function validateLocation(world: WorldDocument, stacks: readonly InventoryStack[], location: InventoryLocation): string | undefined {
  if (!validOwner(world, location.owner)) return `Inventory owner '${ownerName(location.owner)}' does not exist.`;
  if (!location.containerStackId) return undefined;
  const container = stacks.find((stack) => stack.id === location.containerStackId);
  if (!container) return `Container stack '${location.containerStackId}' does not exist.`;
  if (!sameOwner(container.owner, location.owner)) return `Container stack '${container.id}' must have the destination owner.`;
  if (container.quantity !== 1 || !stackDefinition(world, container)?.canContain) return `Stack '${container.id}' is not a single-item container.`;
  return undefined;
}

function validateNoCycle(stacks: readonly InventoryStack[], movingStackId: InventoryStackId, containerStackId?: InventoryStackId): string | undefined {
  if (!containerStackId) return undefined;
  if (movingStackId === containerStackId || isDescendant(stacks, movingStackId, containerStackId)) {
    return `Moving stack '${movingStackId}' into '${containerStackId}' would create a container cycle.`;
  }
  return undefined;
}

function copySnapshot(snapshot: SessionSnapshot, inventory: readonly InventoryStack[], nextInventoryStackOrdinal = snapshot.nextInventoryStackOrdinal): SessionSnapshot {
  return freezeDeep({ ...snapshot, inventory: inventory.map((stack) => ({ ...stack, owner: { ...stack.owner }, fields: { ...stack.fields } })), nextInventoryStackOrdinal });
}

/** Applies one inventory effect to a detached provisional snapshot. Failures never mutate the input. */
export function applyInventoryEffect(
  world: WorldDocument,
  snapshot: SessionSnapshot,
  effect: Extract<Effect, { kind: 'add-item' | 'remove-item' | 'use-item' | 'transfer-item' | 'equip-item' | 'unequip-item' }>,
): InventoryOperationResult {
  const inventory = snapshot.inventory.map((stack) => ({ ...stack, owner: { ...stack.owner }, fields: { ...stack.fields } }));
  if (effect.kind === 'add-item') {
    const item = definition(world, effect.itemId);
    if (!item) return failure(snapshot, `Unknown item '${effect.itemId}'.`);
    if (!validOwner(world, effect.owner)) return failure(snapshot, `Inventory owner '${ownerName(effect.owner)}' does not exist.`);
    if (!Number.isSafeInteger(effect.quantity) || effect.quantity <= 0) return failure(snapshot, `Quantity for '${effect.itemId}' must be a positive safe integer.`);
    if (effect.quantity > item.stackLimit) return failure(snapshot, `Quantity ${effect.quantity} exceeds stack limit ${item.stackLimit} for '${effect.itemId}'.`);
    if (inventory.length >= MAX_INVENTORY_STACKS) return failure(snapshot, `Inventory would exceed ${MAX_INVENTORY_STACKS} stacks.`);
    const fields = fieldsWithDefaults(item, effect.fields ?? {});
    if (!fields) return failure(snapshot, `Fields for '${effect.itemId}' contain an undeclared key or a value with the wrong type.`);
    const location = { owner: effect.owner, ...(effect.containerStackId ? { containerStackId: effect.containerStackId } : {}) };
    const locationError = validateLocation(world, inventory, location);
    if (locationError) return failure(snapshot, locationError);
    const generated = nextStackId(snapshot, inventory);
    if (!generated) return failure(snapshot, `Inventory stack ID ordinal reached its ${MAX_NEXT_STACK_ORDINAL} limit.`);
    const stack: InventoryStack = {
      id: generated.id, owner: effect.owner, itemId: effect.itemId, quantity: effect.quantity,
      ...(effect.containerStackId ? { containerStackId: effect.containerStackId } : {}), fields,
    };
    inventory.push(stack);
    return { ok: true, snapshot: copySnapshot(snapshot, inventory, generated.next), diagnostics: [] };
  }

  const stack = stackById(snapshot, effect.stackId);
  if (!stack) return failure(snapshot, `Inventory stack '${effect.stackId}' does not exist.`);
  if (!validOwner(world, stack.owner)) return failure(snapshot, `Inventory owner '${ownerName(stack.owner)}' does not exist.`);
  const item = stackDefinition(world, stack);
  if (!item) return failure(snapshot, `Unknown item '${stack.itemId}' on inventory stack '${stack.id}'.`);
  const index = inventory.findIndex((candidate) => candidate.id === stack.id);

  if (effect.kind === 'remove-item') {
    if (!Number.isSafeInteger(effect.quantity) || effect.quantity <= 0 || effect.quantity > stack.quantity) {
      return failure(snapshot, `Removal quantity must be positive and no greater than stack '${stack.id}' quantity ${stack.quantity}.`);
    }
    const children = childStacks(inventory, stack.id);
    const remaining = stack.quantity - effect.quantity;
    if (children.length > 0 && remaining !== 1) return failure(snapshot, `Container stack '${stack.id}' must remain quantity one while it contains items.`);
    if (remaining === 0) inventory.splice(index, 1);
    else inventory[index] = { ...stack, quantity: remaining };
    return { ok: true, snapshot: copySnapshot(snapshot, inventory), diagnostics: [] };
  }

  if (effect.kind === 'use-item') {
    if (!item.useEventId) return failure(snapshot, `Item '${item.id}' does not declare a use event.`);
    const eventDefinition = world.eventDefinitions.find((candidate) => candidate.id === item.useEventId);
    if (!eventDefinition) return failure(snapshot, `Use event '${item.useEventId}' is not declared.`);
    const payloadFields = new Map(eventDefinition.payloadFields.map((field) => [field.key, field.valueType]));
    if (payloadFields.size !== 3 || payloadFields.get('stackId') !== 'string' || payloadFields.get('itemId') !== 'string' || payloadFields.get('quantity') !== 'number') {
      return failure(snapshot, `Use event '${item.useEventId}' must declare stackId:string, itemId:string, and quantity:number.`);
    }
    const payload: Record<string, Scalar> = { stackId: stack.id, itemId: stack.itemId, quantity: stack.quantity };
    return {
      ok: true, snapshot: copySnapshot(snapshot, inventory),
      event: { eventId: item.useEventId, payload, source: `inventory-use:${stack.id}` }, diagnostics: [],
    };
  }

  if (effect.kind === 'transfer-item') {
    if (!Number.isSafeInteger(effect.quantity) || effect.quantity <= 0 || effect.quantity > stack.quantity) {
      return failure(snapshot, `Transfer quantity must be positive and no greater than stack '${stack.id}' quantity ${stack.quantity}.`);
    }
    const locationError = validateLocation(world, inventory, effect.destination);
    if (locationError) return failure(snapshot, locationError);
    const cycleError = validateNoCycle(inventory, stack.id, effect.destination.containerStackId);
    if (cycleError) return failure(snapshot, cycleError);
    if (childStacks(inventory, stack.id).length > 0 && (effect.quantity !== stack.quantity || effect.quantity !== 1)) {
      return failure(snapshot, `Container stack '${stack.id}' and its contents must transfer together as one item.`);
    }
    if (stack.equippedSlot && inventory.some((candidate) => candidate.id !== stack.id && sameOwner(candidate.owner, effect.destination.owner) && candidate.equippedSlot === stack.equippedSlot)) {
      return failure(snapshot, `Equipment slot '${stack.equippedSlot}' is already occupied by the destination owner.`);
    }
    if (effect.quantity === stack.quantity) {
      const moved = { ...stack, owner: effect.destination.owner, ...(effect.destination.containerStackId ? { containerStackId: effect.destination.containerStackId } : {}) };
      if (!effect.destination.containerStackId) delete (moved as { containerStackId?: InventoryStackId }).containerStackId;
      inventory[index] = moved;
      if (childStacks(inventory, stack.id).length > 0) {
        for (let childIndex = 0; childIndex < inventory.length; childIndex += 1) {
          const child = inventory[childIndex]!;
          if (child.id !== stack.id && isDescendant(inventory, stack.id, child.id)) {
            inventory[childIndex] = { ...child, owner: effect.destination.owner };
          }
        }
      }
      return { ok: true, snapshot: copySnapshot(snapshot, inventory), diagnostics: [] };
    }
    if (stack.equippedSlot) return failure(snapshot, `Equipped stack '${stack.id}' cannot be split by a partial transfer.`);
    if (inventory.length >= MAX_INVENTORY_STACKS) return failure(snapshot, `Inventory would exceed ${MAX_INVENTORY_STACKS} stacks.`);
    const generated = nextStackId(snapshot, inventory);
    if (!generated) return failure(snapshot, `Inventory stack ID ordinal reached its ${MAX_NEXT_STACK_ORDINAL} limit.`);
    inventory[index] = { ...stack, quantity: stack.quantity - effect.quantity };
    const moved = {
      ...stack, id: generated.id, quantity: effect.quantity, owner: effect.destination.owner,
      ...(effect.destination.containerStackId ? { containerStackId: effect.destination.containerStackId } : {}),
    };
    if (!effect.destination.containerStackId) delete (moved as { containerStackId?: InventoryStackId }).containerStackId;
    inventory.push(moved);
    return { ok: true, snapshot: copySnapshot(snapshot, inventory, generated.next), diagnostics: [] };
  }

  if (effect.kind === 'equip-item') {
    if (!item.equipmentSlot || item.equipmentSlot !== effect.slotId) return failure(snapshot, `Item '${item.id}' is not compatible with equipment slot '${effect.slotId}'.`);
    if (stack.quantity !== 1) return failure(snapshot, `Stack '${stack.id}' must have quantity one to equip.`);
    if (stack.equippedSlot) return failure(snapshot, `Stack '${stack.id}' is already equipped in '${stack.equippedSlot}'.`);
    if (inventory.some((candidate) => sameOwner(candidate.owner, stack.owner) && candidate.equippedSlot === effect.slotId)) return failure(snapshot, `Equipment slot '${effect.slotId}' is already occupied for '${ownerName(stack.owner)}'.`);
    inventory[index] = { ...stack, equippedSlot: effect.slotId };
    return { ok: true, snapshot: copySnapshot(snapshot, inventory), diagnostics: [] };
  }

  if (!stack.equippedSlot || stack.equippedSlot !== effect.slotId) return failure(snapshot, `Stack '${stack.id}' is not equipped in '${effect.slotId}'.`);
  const unequipped = { ...stack };
  delete (unequipped as { equippedSlot?: string }).equippedSlot;
  inventory[index] = unequipped;
  return { ok: true, snapshot: copySnapshot(snapshot, inventory), diagnostics: [] };
}

/** Resolves the player operation to the same validated effect used by authored actions. */
export function inventoryOperationEffect(operation: InventoryPlayerOperation): Extract<Effect, { kind: 'use-item' | 'transfer-item' | 'equip-item' | 'unequip-item' }> | undefined {
  if (!operation || typeof operation !== 'object' || typeof operation.stackId !== 'string' || operation.stackId.length === 0) return undefined;
  switch (operation.kind) {
    case 'use': return { kind: 'use-item', stackId: operation.stackId };
    case 'transfer': {
      const destination = operation.destination;
      if (!destination || typeof destination !== 'object' || !validScopeInput(destination.owner) ||
          (destination.containerStackId !== undefined && typeof destination.containerStackId !== 'string')) return undefined;
      return { kind: 'transfer-item', stackId: operation.stackId, quantity: operation.quantity, destination };
    }
    case 'equip':
      return typeof operation.slotId === 'string' ? { kind: 'equip-item', stackId: operation.stackId, slotId: operation.slotId } : undefined;
    case 'unequip':
      return typeof operation.slotId === 'string' ? { kind: 'unequip-item', stackId: operation.stackId, slotId: operation.slotId } : undefined;
    default: return undefined;
  }
}

function validScopeInput(scope: unknown): scope is StateScope {
  if (!scope || typeof scope !== 'object' || !('kind' in scope)) return false;
  const candidate = scope as { readonly kind: unknown; readonly ownerId?: unknown };
  return candidate.kind === 'world' ||
    ((candidate.kind === 'node' || candidate.kind === 'entity') && typeof candidate.ownerId === 'string');
}

export type { InventoryStack };
