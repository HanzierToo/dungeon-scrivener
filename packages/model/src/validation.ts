import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type {
  ActionSet,
  Condition,
  Diagnostic,
  Effect,
  LocaleDocument,
  ProjectManifest,
  RuleDefinition,
  ScriptIR,
  WorldDocument,
} from './public-types.js';
import commonSchema from '../../../docs/contracts/schemas/common.schema.json';
import localeSchema from '../../../docs/contracts/schemas/locale.schema.json';
import manifestSchema from '../../../docs/contracts/schemas/project-manifest.schema.json';
import scriptIrSchema from '../../../docs/contracts/schemas/script-ir.schema.json';
import scriptBundleSchema from '../../../docs/contracts/schemas/script-bundle.schema.json';
import worldSchema from '../../../docs/contracts/schemas/world.schema.json';

export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly diagnostics: readonly Diagnostic[];
}

export type DocumentVersionStatus = 'supported' | 'unsupported-older' | 'unsupported-future' | 'malformed';

export interface DocumentVersionResult {
  readonly status: DocumentVersionStatus;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProjectValidationInput {
  readonly manifest: unknown;
  readonly world: unknown;
  readonly locales?: Readonly<Record<string, unknown>>;
  readonly scriptBundle?: unknown;
  /** Paths retained in the project's virtual file tree. */
  readonly filePaths?: ReadonlySet<string>;
  /** Hashes of assets present in the managed asset store. */
  readonly assetHashes?: ReadonlySet<string>;
}

export interface ValidatedProjectDocuments {
  readonly manifest: ProjectManifest;
  readonly world: WorldDocument;
  readonly locales: Readonly<Record<string, LocaleDocument>>;
  readonly scriptBundle?: unknown;
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
ajv.addSchema(commonSchema);
const validators = {
  manifest: ajv.compile(manifestSchema),
  world: ajv.compile(worldSchema),
  locale: ajv.compile(localeSchema),
  scriptIr: ajv.compile(scriptIrSchema),
  scriptBundle: ajv.compile(scriptBundleSchema),
};

/** Inspect version policy before schema validation; never migrate source documents implicitly. */
export function inspectDocumentVersion(value: unknown, path: string): DocumentVersionResult {
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value)) {
    return { status: 'malformed', diagnostics: [] };
  }
  const version = (value as Record<string, unknown>)['schemaVersion'];
  if (!Number.isSafeInteger(version)) return { status: 'malformed', diagnostics: [] };
  if (version === 1) return { status: 'supported', diagnostics: [] };
  if (typeof version === 'number' && version > 1) {
    return {
      status: 'unsupported-future',
      diagnostics: [{
        code: 'DS-MOD-017', severity: 'error',
        message: `Schema version ${version} is newer than supported version 1; the document is preserved for recovery and opened read-only.`,
        path, suggestedFix: 'Open this document with a version that supports its schema, or export the original project unchanged.',
        blocks: ['play'],
      }],
    };
  }
  return {
    status: 'unsupported-older',
    diagnostics: [{
      code: 'DS-MOD-018', severity: 'error',
      message: `Schema version ${String(version)} requires an explicit named migration before normal validation.`,
      path, suggestedFix: 'Use a supported named migration, or open the original document unchanged for recovery.',
      blocks: ['play'],
    }],
  };
}

function jsonPointer(path: string): string {
  return path || '/';
}

function entityIdAt(root: unknown, instancePath: string): string | undefined {
  if (typeof root !== 'object' || root === null) return undefined;
  const parts = instancePath.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current: unknown = root;
  let nearest: string | undefined;
  if (typeof current === 'object' && current !== null && 'id' in current && typeof current.id === 'string') {
    nearest = current.id;
  }
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) break;
    current = (current as Record<string, unknown>)[part];
    if (typeof current === 'object' && current !== null && 'id' in current && typeof current.id === 'string') {
      nearest = current.id;
    }
  }
  return nearest;
}

function schemaDiagnostics(errors: readonly ErrorObject[] | null | undefined, root: unknown, filePath: string): Diagnostic[] {
  return (errors ?? []).map((error) => {
    const entityId = entityIdAt(root, error.instancePath);
    const missingProperty = error.params['missingProperty'];
    const location = error.instancePath + (error.keyword === 'required' && typeof missingProperty === 'string'
      ? `/${missingProperty}`
      : '');
    return {
      code: 'DS-MOD-001',
      severity: 'error',
      message: `Schema validation failed at ${jsonPointer(location)}: ${error.message ?? 'invalid value'}.`,
      path: filePath,
      ...(entityId ? { entityId } : {}),
      blocks: ['play', 'export'],
    };
  });
}

function validateSchema<T>(validator: ValidateFunction, value: unknown, path: string): ValidationResult<T> {
  if (validator(value)) return { ok: true, value: value as T, diagnostics: [] };
  return { ok: false, diagnostics: schemaDiagnostics(validator.errors, value, path) };
}

/**
 * Apply only contract-defined defaults to a detached JSON copy. The caller's
 * parsed object and its original source bytes are never changed.
 */
export function applyWorldDefaults(world: WorldDocument): WorldDocument {
  const copy = structuredClone(world) as WorldDocument;
  const worldFields = copy.stateDefinitions.filter((field) => field.scopeKind === 'world');
  const nodeFields = copy.stateDefinitions.filter((field) => field.scopeKind === 'node');
  (copy as { worldState: WorldDocument['worldState'] }).worldState = {
    ...Object.fromEntries(worldFields.map((field) => [field.key, field.defaultValue])),
    ...copy.worldState,
  };
  for (let index = 0; index < copy.nodes.length; index += 1) {
    const node = copy.nodes[index];
    if (!node) continue;
    if (node.inheritance === undefined) {
      (node as { inheritance?: WorldDocument['nodes'][number]['inheritance'] }).inheritance = {
        defaults: false,
        rules: false,
      };
    }
    (node as { state?: WorldDocument['nodes'][number]['state'] }).state = {
      ...Object.fromEntries(nodeFields.map((field) => [field.key, field.defaultValue])),
      ...node.state,
    };
  }
  const entityDefinitions = new Map(copy.entityDefinitions.map((definition) => [definition.id, definition]));
  for (const entity of copy.entities) {
    const definition = entityDefinitions.get(entity.definitionId);
    if (!definition) continue;
    (entity as { state: WorldDocument['entities'][number]['state'] }).state = {
      ...Object.fromEntries(definition.fields.map((field) => [field.key, field.defaultValue])),
      ...entity.state,
    };
  }
  if (copy.settings.typingSounds === undefined) {
    (copy.settings as { typingSounds?: WorldDocument['settings']['typingSounds'] }).typingSounds = {
      mappings: [],
      fallback: { kind: 'silent' },
    };
  }
  return copy;
}

export function validateProjectManifest(value: unknown, path = 'project.json'): ValidationResult<ProjectManifest> {
  const version = inspectDocumentVersion(value, path);
  if (version.status !== 'supported' && version.diagnostics.length > 0) return { ok: false, diagnostics: version.diagnostics };
  return validateSchema<ProjectManifest>(validators.manifest, value, path);
}

export function validateWorldDocument(value: unknown, path = 'world.json'): ValidationResult<WorldDocument> {
  const version = inspectDocumentVersion(value, path);
  if (version.status !== 'supported' && version.diagnostics.length > 0) return { ok: false, diagnostics: version.diagnostics };
  const structural = validateSchema<WorldDocument>(validators.world, value, path);
  if (!structural.ok || !structural.value) return structural;
  const diagnostics = worldSemanticDiagnostics(structural.value, path);
  if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, diagnostics };
  return { ok: true, value: applyWorldDefaults(structural.value), diagnostics };
}

export function validateLocaleDocument(value: unknown, path: string): ValidationResult<LocaleDocument> {
  const version = inspectDocumentVersion(value, path);
  if (version.status !== 'supported' && version.diagnostics.length > 0) return { ok: false, diagnostics: version.diagnostics };
  return validateSchema<LocaleDocument>(validators.locale, value, path);
}

export function validateScriptIR(value: unknown, path: string): ValidationResult<ScriptIR> {
  const version = inspectDocumentVersion(value, path);
  if (version.status !== 'supported' && version.diagnostics.length > 0) return { ok: false, diagnostics: version.diagnostics };
  return validateSchema<ScriptIR>(validators.scriptIr, value, path);
}

export function validateScriptBundle(value: unknown, path = 'scripts/compiled.json'): ValidationResult<unknown> {
  const version = inspectDocumentVersion(value, path);
  if (version.status !== 'supported' && version.diagnostics.length > 0) return { ok: false, diagnostics: version.diagnostics };
  return validateSchema<unknown>(validators.scriptBundle, value, path);
}

function isTypedValue(value: unknown, definition: { readonly valueType: unknown }): boolean {
  const type = definition.valueType;
  if (typeof type === 'object' && type !== null && 'kind' in type && type.kind === 'enum' && 'values' in type && Array.isArray(type.values)) {
    return typeof value === 'string' && type.values.includes(value);
  }
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return false;
}

/** Resolve an authored wiki target by stable node ID, never by display text. */
export function resolveWikiNodeTarget(world: WorldDocument, targetId: string): ValidationResult<WorldDocument['nodes'][number]> {
  const matches = world.nodes.filter((node) => node.id === targetId);
  const match = matches[0];
  if (matches.length === 1 && match) return { ok: true, value: match, diagnostics: [] };
  return {
    ok: false,
    diagnostics: [{
      code: 'DS-MOD-032', severity: 'error',
      message: matches.length === 0
        ? `Wiki link target '${targetId}' does not name a node ID.`
        : `Wiki link target '${targetId}' is duplicated and cannot be resolved safely.`,
      path: 'world.json',
      ...(/^[a-z][a-z0-9-]{0,63}$/.test(targetId) ? { entityId: targetId } : {}),
      suggestedFix: 'Use the stable ID of exactly one node in the [[node:<id>]] target.',
    }],
  };
}

/** Resolve effective choices/commands with parent inheritance and node overrides. */
export function resolveNodeActions(world: WorldDocument, nodeId: string): ValidationResult<ActionSet> {
  const nodes = new Map(world.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const resolve = (currentId: string): ActionSet | undefined => {
    const node = nodes.get(currentId);
    if (!node) return undefined;
    if (seen.has(currentId)) return undefined;
    seen.add(currentId);
    let base = world.actionDefaults;
    if (node.inheritance?.defaults && node.parentId !== null) {
      const inherited = resolve(node.parentId);
      if (!inherited) return undefined;
      base = inherited;
    }
    return {
      choices: node.actions?.choices ?? base.choices,
      commands: node.actions?.commands ?? base.commands,
    };
  };
  const value = resolve(nodeId);
  if (value) return { ok: true, value, diagnostics: [] };
  return {
    ok: false,
    diagnostics: [{
      code: 'DS-MOD-033', severity: 'error',
      message: nodes.has(nodeId) ? `Containment cycle prevents resolving inherited settings for node '${nodeId}'.` : `Node '${nodeId}' does not exist.`,
      path: 'world.json', entityId: nodeId,
      suggestedFix: nodes.has(nodeId) ? 'Remove the containment cycle or disable inheritance along the cycle.' : 'Use an existing stable node ID.',
    }],
  };
}

/** Resolve node and inherited parent rules in parent-first authored order. */
export function resolveNodeRules(world: WorldDocument, nodeId: string): ValidationResult<readonly RuleDefinition[]> {
  const nodes = new Map(world.nodes.map((node) => [node.id, node]));
  const rules = new Map(world.rules.map((rule) => [rule.id, rule]));
  const seen = new Set<string>();
  const resolve = (currentId: string): RuleDefinition[] | undefined => {
    const node = nodes.get(currentId);
    if (!node || seen.has(currentId)) return undefined;
    seen.add(currentId);
    const result = node.inheritance?.rules && node.parentId !== null ? resolve(node.parentId) : [];
    if (!result) return undefined;
    for (const id of node.ruleIds ?? []) {
      const rule = rules.get(id);
      if (!rule) return undefined;
      result.push(rule);
    }
    return result;
  };
  const value = resolve(nodeId);
  if (value) return { ok: true, value, diagnostics: [] };
  return {
    ok: false,
    diagnostics: [{
      code: 'DS-MOD-034', severity: 'error',
      message: nodes.has(nodeId) ? `Containment cycle or missing rule prevents resolving inherited rules for node '${nodeId}'.` : `Node '${nodeId}' does not exist.`,
      path: 'world.json', entityId: nodeId,
      suggestedFix: 'Repair the containment chain and ensure every rule ID names a declared rule.',
    }],
  };
}

function worldSemanticDiagnostics(world: WorldDocument, path: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string, entityId?: string) => diagnostics.push({
    code,
    severity: 'error',
    message,
    path,
    ...(entityId ? { entityId } : {}),
    suggestedFix: code === 'DS-MOD-030'
      ? 'Reparent one of the nodes to remove the containment cycle.'
      : code === 'DS-MOD-004'
        ? 'Assign a unique stable ID within this collection.'
        : 'Correct the stable ID reference or add the missing target.',
    blocks: ['play', 'export'],
  });

  const entry = world.nodes.find((node) => node.id === world.entryNodeId);
  if (!entry) error('DS-MOD-002', `Entry node '${world.entryNodeId}' does not exist.`, world.entryNodeId);
  else if (!entry.visitable) error('DS-MOD-003', 'The entry node must be visitable.', entry.id);

  const collections: ReadonlyArray<readonly { readonly id: string }[]> = [
    world.nodes,
    world.navigationEdges,
    world.entityDefinitions,
    world.entities,
    world.eventDefinitions,
    world.rules,
    world.conversations,
    world.itemDefinitions,
    world.scripts,
  ];
  for (const entries of collections) {
    const seen = new Set<string>();
    for (const item of entries) {
      if (seen.has(item.id)) error('DS-MOD-004', `Duplicate stable ID '${item.id}' in its collection.`, item.id);
      seen.add(item.id);
    }
  }

  const definitions = new Map(world.stateDefinitions.filter((field) => field.scopeKind === 'world').map((field) => [field.key, field]));
  const scopedDefinitionKeys = new Set<string>();
  for (const field of world.stateDefinitions) {
    const scopedKey = `${field.scopeKind}:${field.key}`;
    if (scopedDefinitionKeys.has(scopedKey)) error('DS-MOD-004', `Duplicate ${field.scopeKind}-scoped state key '${field.key}'.`, field.key);
    scopedDefinitionKeys.add(scopedKey);
    if (!isTypedValue(field.defaultValue, field)) error('DS-MOD-005', `Default value for state key '${field.key}' does not match its declared type.`, field.key);
  }
  const checkDuplicateIds = (ids: readonly string[], ownerId: string): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) error('DS-MOD-004', `Duplicate stable ID '${id}' within '${ownerId}'.`, id);
      seen.add(id);
    }
  };
  for (const [key, value] of Object.entries(world.worldState)) {
    const definition = definitions.get(key);
    if (!definition) error('DS-MOD-006', `World state key '${key}' has no definition.`, key);
    else if (!isTypedValue(value, definition)) error('DS-MOD-007', `World state key '${key}' does not match its declared type.`, key);
  }
  for (const node of world.nodes) {
    const parent = node.parentId;
    if (parent !== null && !world.nodes.some((candidate) => candidate.id === parent)) error('DS-MOD-008', `Containment parent '${parent}' does not exist.`, node.id);
    for (const [key, value] of Object.entries(node.state ?? {})) {
      const definition = world.stateDefinitions.find((field) => field.scopeKind === 'node' && field.key === key);
      if (!definition) error('DS-MOD-006', `Node state key '${key}' has no node-scoped definition.`, node.id);
      else if (!isTypedValue(value, definition)) error('DS-MOD-007', `Node state key '${key}' does not match its declared type.`, node.id);
    }
  }
  for (const edge of world.navigationEdges) {
    if (!world.nodes.some((node) => node.id === edge.fromNodeId)) error('DS-MOD-009', `Navigation source '${edge.fromNodeId}' does not exist.`, edge.id);
    if (!world.nodes.some((node) => node.id === edge.toNodeId)) error('DS-MOD-010', `Navigation target '${edge.toNodeId}' does not exist.`, edge.id);
  }

  const nodesById = new Map(world.nodes.map((node) => [node.id, node]));
  const edgeIds = new Set(world.navigationEdges.map((edge) => edge.id));
  const entityIds = new Set(world.entities.map((entity) => entity.id));
  const eventIds = new Set(world.eventDefinitions.map((event) => event.id));
  const conversationIds = new Set(world.conversations.map((conversation) => conversation.id));
  const itemIds = new Set(world.itemDefinitions.map((item) => item.id));
  const scriptIds = new Set(world.scripts.map((script) => script.id));
  const ruleIds = new Set(world.rules.map((rule) => rule.id));
  const validateStateReference = (reference: { readonly scope: { readonly kind: string; readonly ownerId?: string }; readonly key: string }, ownerId: string) => {
    if (reference.scope.kind === 'world') {
      if (!world.stateDefinitions.some((field) => field.scopeKind === 'world' && field.key === reference.key)) error('DS-MOD-020', `World state key '${reference.key}' is not defined.`, ownerId);
    } else if (reference.scope.kind === 'node') {
      if (!reference.scope.ownerId || !nodesById.has(reference.scope.ownerId)) error('DS-MOD-021', `State reference names missing node '${reference.scope.ownerId ?? ''}'.`, ownerId);
      else if (!world.stateDefinitions.some((field) => field.scopeKind === 'node' && field.key === reference.key)) error('DS-MOD-020', `Node state key '${reference.key}' is not defined.`, ownerId);
    } else if (reference.scope.kind === 'entity') {
      const entity = reference.scope.ownerId ? world.entities.find((candidate) => candidate.id === reference.scope.ownerId) : undefined;
      if (!entity) error('DS-MOD-022', `State reference names missing entity '${reference.scope.ownerId ?? ''}'.`, ownerId);
      else {
        const definition = world.entityDefinitions.find((candidate) => candidate.id === entity.definitionId);
        if (!definition?.fields.some((field) => field.key === reference.key)) error('DS-MOD-020', `Entity state key '${reference.key}' is not defined.`, ownerId);
      }
    }
  };
  const validateCondition = (condition: Condition | undefined, ownerId: string): void => {
    if (!condition) return;
    switch (condition.kind) {
      case 'all':
      case 'any':
        condition.conditions.forEach((child) => validateCondition(child, ownerId));
        break;
      case 'not':
        validateCondition(condition.condition, ownerId);
        break;
      case 'compare-state':
        validateStateReference(condition.left, ownerId);
        break;
      case 'has-tag':
        if (!entityIds.has(condition.entityId)) error('DS-MOD-022', `Condition references missing entity '${condition.entityId}'.`, ownerId);
        break;
      case 'at-node':
        if (!nodesById.has(condition.nodeId)) error('DS-MOD-021', `Condition references missing node '${condition.nodeId}'.`, ownerId);
        break;
      case 'event-is':
        if (!eventIds.has(condition.eventId)) error('DS-MOD-023', `Condition references missing event '${condition.eventId}'.`, ownerId);
        break;
      case 'time-at-least':
        break;
    }
  };
  const validateEffects = (effects: readonly Effect[], ownerId: string): void => {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'set-state':
        case 'increment-state':
          validateStateReference(effect.target, ownerId);
          break;
        case 'add-tag':
        case 'remove-tag':
          if (!entityIds.has(effect.entityId)) error('DS-MOD-022', `Effect references missing entity '${effect.entityId}'.`, ownerId);
          break;
        case 'emit-event':
          if (!eventIds.has(effect.eventId)) error('DS-MOD-023', `Effect references missing event '${effect.eventId}'.`, ownerId);
          break;
        case 'navigate':
          if (!edgeIds.has(effect.edgeId)) error('DS-MOD-024', `Effect references missing navigation edge '${effect.edgeId}'.`, ownerId);
          break;
        case 'add-item':
        case 'remove-item':
          if (!itemIds.has(effect.itemId)) error('DS-MOD-025', `Effect references missing item '${effect.itemId}'.`, ownerId);
          if (effect.owner.kind === 'node' && !nodesById.has(effect.owner.ownerId)) error('DS-MOD-021', `Effect references missing owner node '${effect.owner.ownerId}'.`, ownerId);
          if (effect.owner.kind === 'entity' && !entityIds.has(effect.owner.ownerId)) error('DS-MOD-022', `Effect references missing owner entity '${effect.owner.ownerId}'.`, ownerId);
          break;
        case 'start-conversation':
        case 'interrupt-conversation':
        case 'resume-conversation':
          if (!conversationIds.has(effect.conversationId)) error('DS-MOD-026', `Effect references missing conversation '${effect.conversationId}'.`, ownerId);
          break;
        case 'run-script':
          if (!scriptIds.has(effect.scriptId)) error('DS-MOD-027', `Effect references missing script '${effect.scriptId}'.`, ownerId);
          break;
      }
    }
  };
  const validateActionSet = (actions: ActionSet): void => {
    checkDuplicateIds([...actions.choices.map((choice) => choice.id), ...actions.commands.map((command) => command.id)], 'action set');
    for (const choice of actions.choices) {
      validateCondition(choice.condition, choice.id);
      if (choice.navigationEdgeId && !edgeIds.has(choice.navigationEdgeId)) error('DS-MOD-024', `Choice references missing navigation edge '${choice.navigationEdgeId}'.`, choice.id);
      validateEffects(choice.effects, choice.id);
    }
    for (const command of actions.commands) {
      checkDuplicateIds(command.parameters.map((parameter) => parameter.id), command.id);
      validateCondition(command.condition, command.id);
      if (command.navigationEdgeId && !edgeIds.has(command.navigationEdgeId)) error('DS-MOD-024', `Command references missing navigation edge '${command.navigationEdgeId}'.`, command.id);
      validateEffects(command.effects, command.id);
    }
  };
  validateActionSet(world.actionDefaults);
  for (const node of world.nodes) {
    for (const ruleId of node.ruleIds ?? []) if (!ruleIds.has(ruleId)) error('DS-MOD-028', `Node references missing rule '${ruleId}'.`, node.id);
    if (node.actions) validateActionSet({ choices: node.actions.choices ?? [], commands: node.actions.commands ?? [] });
    for (const lifecycle of Object.values(node.lifecycle ?? {})) if (lifecycle) validateEffects(lifecycle.effects, node.id);
  }
  for (const edge of world.navigationEdges) validateCondition(edge.condition, edge.id);
  for (const rule of world.rules) {
    if (rule.trigger.kind === 'event' && !eventIds.has(rule.trigger.eventId)) error('DS-MOD-023', `Rule listens to missing event '${rule.trigger.eventId}'.`, rule.id);
    validateCondition(rule.condition, rule.id);
    validateEffects(rule.effects, rule.id);
  }
  for (const item of world.itemDefinitions) if (item.useEventId && !eventIds.has(item.useEventId)) error('DS-MOD-023', `Item references missing use event '${item.useEventId}'.`, item.id);
  for (const checkpointId of world.savePolicy.checkpointNodeIds ?? []) if (!nodesById.has(checkpointId)) error('DS-MOD-021', `Save policy references missing checkpoint node '${checkpointId}'.`, checkpointId);
  for (const stack of world.initialInventory) {
    if (!itemIds.has(stack.itemId)) error('DS-MOD-025', `Initial inventory references missing item '${stack.itemId}'.`, stack.itemId);
    if (stack.owner.kind === 'node' && !nodesById.has(stack.owner.ownerId)) error('DS-MOD-021', `Initial inventory references missing node '${stack.owner.ownerId}'.`, stack.itemId);
    if (stack.owner.kind === 'entity' && !entityIds.has(stack.owner.ownerId)) error('DS-MOD-022', `Initial inventory references missing entity '${stack.owner.ownerId}'.`, stack.itemId);
    if (stack.containerItemId) {
      const container = world.itemDefinitions.find((item) => item.id === stack.containerItemId);
      if (!container) error('DS-MOD-025', `Initial inventory references missing container '${stack.containerItemId}'.`, stack.itemId);
      else if (!container.canContain) error('DS-MOD-036', `Initial inventory parent item '${stack.containerItemId}' is not declared as a container.`, stack.itemId);
    }
  }
  for (const conversation of world.conversations) {
    const lineIds = new Set(conversation.lines.map((line) => line.id));
    checkDuplicateIds(conversation.lines.map((line) => line.id), conversation.id);
    checkDuplicateIds(conversation.lines.flatMap((line) => (line.options ?? []).map((option) => option.id)), conversation.id);
    if (!lineIds.has(conversation.entryLineId)) error('DS-MOD-029', `Conversation entry line '${conversation.entryLineId}' does not exist.`, conversation.id);
    for (const participantId of conversation.participantEntityIds) if (!entityIds.has(participantId)) error('DS-MOD-022', `Conversation references missing participant '${participantId}'.`, conversation.id);
    for (const line of conversation.lines) {
      if (!entityIds.has(line.speakerEntityId)) error('DS-MOD-022', `Dialogue line references missing speaker '${line.speakerEntityId}'.`, line.id);
      if (line.nextLineId && !lineIds.has(line.nextLineId)) error('DS-MOD-029', `Dialogue line references missing next line '${line.nextLineId}'.`, line.id);
      validateCondition(line.condition, line.id);
      for (const option of line.options ?? []) {
        if (option.nextLineId && !lineIds.has(option.nextLineId)) error('DS-MOD-029', `Dialogue option references missing next line '${option.nextLineId}'.`, option.id);
        validateCondition(option.condition, option.id);
        validateEffects(option.effects, option.id);
      }
    }
  }

  const containmentState = new Map<string, 'visiting' | 'done'>();
  const visitContainment = (nodeId: string, trail: string[]): void => {
    if (containmentState.get(nodeId) === 'done') return;
    if (containmentState.get(nodeId) === 'visiting') {
      error('DS-MOD-030', `Containment cycle detected: ${[...trail, nodeId].join(' -> ')}.`, nodeId);
      return;
    }
    containmentState.set(nodeId, 'visiting');
    const parentId = nodesById.get(nodeId)?.parentId;
    if (parentId && nodesById.has(parentId)) visitContainment(parentId, [...trail, nodeId]);
    containmentState.set(nodeId, 'done');
  };
  for (const node of world.nodes) visitContainment(node.id, []);

  const reachable = new Set<string>();
  if (entry) {
    const outgoing = new Map<string, string[]>();
    for (const edge of world.navigationEdges) outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge.toNodeId]);
    const pending = [entry.id];
    while (pending.length > 0) {
      const nodeId = pending.pop();
      if (!nodeId || reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      pending.push(...(outgoing.get(nodeId) ?? []));
    }
  }
  for (const node of world.nodes) if (node.visitable && !reachable.has(node.id)) diagnostics.push({
    code: 'DS-MOD-031', severity: 'warning',
    message: `Visitable node '${node.id}' cannot be reached from the entry node by authored navigation edges.`,
    path, entityId: node.id,
    suggestedFix: 'Add a navigation edge from a reachable node, or mark this node nonvisitable if it is organizational content.',
  });

  for (const definition of world.entityDefinitions) {
    const fieldKeys = new Set<string>();
    for (const field of definition.fields) {
      if (fieldKeys.has(field.key)) error('DS-MOD-004', `Duplicate entity field '${field.key}'.`, definition.id);
      fieldKeys.add(field.key);
      if (!isTypedValue(field.defaultValue, field)) error('DS-MOD-005', `Default value for entity field '${field.key}' does not match its declared type.`, definition.id);
    }
  }
  for (const definition of world.eventDefinitions) {
    checkDuplicateIds(definition.payloadFields.map((field) => field.key), definition.id);
    for (const field of definition.payloadFields) if (!isTypedValue(field.defaultValue, field)) error('DS-MOD-005', `Default value for event payload field '${field.key}' does not match its declared type.`, definition.id);
  }
  for (const definition of world.itemDefinitions) {
    checkDuplicateIds(definition.fields.map((field) => field.key), definition.id);
    for (const field of definition.fields) if (!isTypedValue(field.defaultValue, field)) error('DS-MOD-005', `Default value for item field '${field.key}' does not match its declared type.`, definition.id);
  }
  for (const entity of world.entities) {
    const definition = world.entityDefinitions.find((candidate) => candidate.id === entity.definitionId);
    if (!definition) {
      error('DS-MOD-011', `Entity definition '${entity.definitionId}' does not exist.`, entity.id);
      continue;
    }
    for (const tag of entity.tags) if (!definition.allowedTags.includes(tag)) error('DS-MOD-035', `Entity tag '${tag}' is not allowed by definition '${definition.id}'.`, entity.id);
    for (const [key, value] of Object.entries(entity.state)) {
      const field = definition.fields.find((candidate) => candidate.key === key);
      if (!field) error('DS-MOD-006', `Entity state key '${key}' has no field definition.`, entity.id);
      else if (!isTypedValue(value, field)) error('DS-MOD-007', `Entity state key '${key}' does not match its declared type.`, entity.id);
    }
  }
  return diagnostics;
}

function collectLocaleKeys(value: unknown, entityId?: string, found: Array<{ key: string; entityId?: string }> = []): Array<{ key: string; entityId?: string }> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectLocaleKeys(item, entityId, found));
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const currentEntity = typeof record['id'] === 'string' ? record['id'] : entityId;
    if (record['kind'] === 'locale-key' && typeof record['key'] === 'string') found.push({ key: record['key'], ...(currentEntity ? { entityId: currentEntity } : {}) });
    for (const child of Object.values(record)) collectLocaleKeys(child, currentEntity, found);
  }
  return found;
}

/** Validate the frozen document schemas and project-local locale/script/media references. */
export function validateProject(input: ProjectValidationInput): ValidationResult<ValidatedProjectDocuments> {
  const diagnostics: Diagnostic[] = [];
  const manifestResult = validateProjectManifest(input.manifest);
  const worldResult = validateWorldDocument(input.world);
  diagnostics.push(...manifestResult.diagnostics, ...worldResult.diagnostics);
  const locales: Record<string, LocaleDocument> = {};
  for (const [path, value] of Object.entries(input.locales ?? {})) {
    const result = validateLocaleDocument(value, path);
    diagnostics.push(...result.diagnostics);
    if (result.ok && result.value) locales[path] = result.value;
  }
  if (input.scriptBundle !== undefined) {
    const result = validateScriptBundle(input.scriptBundle);
    diagnostics.push(...result.diagnostics);
  }
  if (!manifestResult.value || !worldResult.value || diagnostics.some((item) => item.severity === 'error')) return { ok: false, diagnostics };

  const localeDocuments = Object.values(locales);
  const defaultLocale = manifestResult.value.defaultLocale;
  const defaultDocument = localeDocuments.find((locale) => locale.locale === defaultLocale);
  const keys = collectLocaleKeys(worldResult.value);
  for (const { key, entityId } of keys) {
    if (typeof defaultDocument?.strings[key] !== 'string') {
      diagnostics.push({
        code: 'DS-MOD-012', severity: 'warning',
        message: `Locale key '${key}' is missing from default locale '${defaultLocale}'; the key will be shown as fallback text.`,
        path: defaultDocument ? Object.keys(locales).find((localePath) => locales[localePath] === defaultDocument) ?? 'world.json' : 'world.json',
        ...(entityId ? { entityId } : {}),
      });
    }
  }

  for (const script of worldResult.value.scripts) {
    if (input.filePaths && !input.filePaths.has(script.path)) diagnostics.push({
      code: 'DS-MOD-013', severity: 'error', message: `Declared ${script.language} script file '${script.path}' is missing.`,
      path: script.path, entityId: script.id, blocks: ['play', 'export'],
    });
  }
  if (input.filePaths && worldResult.value.settings.playerStylePath && !input.filePaths.has(worldResult.value.settings.playerStylePath)) diagnostics.push({
    code: 'DS-MOD-014', severity: 'error', message: `Player style file '${worldResult.value.settings.playerStylePath}' is missing.`,
    path: worldResult.value.settings.playerStylePath, blocks: ['play', 'export'],
  });
  if (input.assetHashes) {
    const typing = worldResult.value.settings.typingSounds;
    for (const mapping of typing?.mappings ?? []) {
      if (!input.assetHashes.has(mapping.assetHash)) diagnostics.push({
        code: 'DS-MOD-015', severity: 'error', message: `Typing sound asset '${mapping.assetHash}' is missing.`,
        path: 'world.json', blocks: ['play', 'export'],
      });
    }
    if (typing?.fallback.kind === 'asset' && !input.assetHashes.has(typing.fallback.assetHash)) diagnostics.push({
      code: 'DS-MOD-015', severity: 'error', message: `Typing sound fallback asset '${typing.fallback.assetHash}' is missing.`,
      path: 'world.json', blocks: ['play', 'export'],
    });
  }
  if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, diagnostics };
  return {
    ok: true,
    value: {
      manifest: manifestResult.value,
      world: worldResult.value,
      locales,
      ...(input.scriptBundle === undefined ? {} : { scriptBundle: input.scriptBundle }),
    },
    diagnostics,
  };
}

/** Parse JSON without changing the original byte array; return precise file diagnostics. */
export function parseJsonDocument(bytes: Uint8Array, path: string): ValidationResult<unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown, diagnostics: [] };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'invalid JSON';
    return { ok: false, diagnostics: [{
      code: 'DS-MOD-016', severity: 'error', message: `Cannot parse JSON: ${detail}.`, path, blocks: ['play', 'export'],
    }] };
  }
}
