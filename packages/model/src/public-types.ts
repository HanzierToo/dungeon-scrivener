/** Stable contracts shared by DungeonScrivener packages. This file declares types only. */

export type SchemaVersion = 1;
export type StableId = string;
export type ProjectId = StableId;
export type NodeId = StableId;
export type EntityId = StableId;
export type EventId = StableId;
export type RuleId = StableId;
export type ChoiceId = StableId;
export type CommandId = StableId;
export type ConversationId = StableId;
export type DialogueLineId = StableId;
export type ItemId = StableId;
export type ScriptId = StableId;
export type LocaleKey = StableId;
export type StateKey = StableId;
export type VfsPath = string;
export type Sha256Hex = string;
export type ContentDigest = `sha256:${string}`;
export type LocaleTag = string;
export type Scalar = string | number | boolean;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonRecord = Readonly<Record<string, JsonValue>>;
export type ScalarRecord = Readonly<Record<string, Scalar>>;
export type GameVersion = string;

export interface ProjectManifest {
  readonly format: 'dungeon-scrivener-project';
  readonly schemaVersion: SchemaVersion;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly defaultLocale: LocaleTag;
  /** Authoritative content compatibility version copied into player saves. */
  readonly gameVersion: GameVersion;
}

export interface LocaleDocument {
  readonly format: 'dungeon-scrivener-locale';
  readonly schemaVersion: SchemaVersion;
  readonly locale: LocaleTag;
  readonly strings: Readonly<Record<LocaleKey, string>>;
}

export type ValueType = 'string' | 'number' | 'integer' | 'boolean' | EnumValueType;

export interface EnumValueType {
  readonly kind: 'enum';
  readonly values: readonly string[];
}

export interface StateFieldDefinition {
  readonly key: StateKey;
  readonly valueType: ValueType;
  readonly defaultValue: Scalar;
}

export type StateScope =
  | { readonly kind: 'world' }
  | { readonly kind: 'node'; readonly ownerId: NodeId }
  | { readonly kind: 'entity'; readonly ownerId: EntityId };

export interface StateReference {
  readonly scope: StateScope;
  readonly key: StateKey;
}

export type TextSource =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'locale-key'; readonly key: LocaleKey };

export type Condition =
  | { readonly kind: 'all'; readonly conditions: readonly Condition[] }
  | { readonly kind: 'any'; readonly conditions: readonly Condition[] }
  | { readonly kind: 'not'; readonly condition: Condition }
  | { readonly kind: 'compare-state'; readonly left: StateReference; readonly operator: ComparisonOperator; readonly right: Scalar }
  | { readonly kind: 'has-tag'; readonly entityId: EntityId; readonly tag: string }
  | { readonly kind: 'at-node'; readonly nodeId: NodeId }
  | { readonly kind: 'event-is'; readonly eventId: EventId }
  | { readonly kind: 'time-at-least'; readonly milliseconds: number };

export type ComparisonOperator = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';

export type Effect =
  | { readonly kind: 'set-state'; readonly target: StateReference; readonly value: Scalar }
  | { readonly kind: 'increment-state'; readonly target: StateReference; readonly amount: number }
  | { readonly kind: 'add-tag' | 'remove-tag'; readonly entityId: EntityId; readonly tag: string }
  | { readonly kind: 'emit-event'; readonly eventId: EventId; readonly payload: JsonRecord }
  | { readonly kind: 'navigate'; readonly edgeId: StableId }
  | { readonly kind: 'add-item' | 'remove-item'; readonly owner: StateScope; readonly itemId: ItemId; readonly quantity: number }
  | { readonly kind: 'start-conversation' | 'interrupt-conversation' | 'resume-conversation'; readonly conversationId: ConversationId }
  | { readonly kind: 'run-script'; readonly scriptId: ScriptId };

/** Effects available to script capabilities. Scripts cannot request a new script activation. */
export type ScriptEffect = Exclude<Effect, { readonly kind: 'run-script' }>;

export interface EventOccurrence {
  readonly eventId: EventId;
  readonly payload: JsonRecord;
  readonly source: string;
}

export interface ChoiceDefinition {
  readonly id: ChoiceId;
  readonly label: TextSource;
  readonly condition?: Condition;
  readonly falsePolicy?: 'hide' | 'disable';
  readonly navigationEdgeId?: StableId;
  readonly effects: readonly Effect[];
}

export interface CommandParameterDefinition {
  readonly id: StableId;
  readonly valueType: ValueType;
}

export interface CommandDefinition {
  readonly id: CommandId;
  /** Primary pattern first, then aliases. `{parameterId}` captures one input token. */
  readonly patterns: readonly string[];
  readonly parameters: readonly CommandParameterDefinition[];
  readonly condition?: Condition;
  readonly falsePolicy?: 'hide' | 'disable';
  readonly navigationEdgeId?: StableId;
  readonly effects: readonly Effect[];
}

export interface ActionSet {
  readonly choices: readonly ChoiceDefinition[];
  readonly commands: readonly CommandDefinition[];
}

export interface LifecycleEffects {
  readonly policy: 'every-time' | 'first-time' | 'once-per-playthrough';
  readonly effects: readonly Effect[];
}

export interface NodeDefinition {
  readonly id: NodeId;
  readonly parentId: NodeId | null;
  readonly visitable: boolean;
  readonly title: TextSource;
  readonly content: TextSource;
  readonly inheritance?: {
    readonly defaults: boolean;
    readonly rules: boolean;
  };
  /** Present categories replace the corresponding game defaults. An empty array disables that category. */
  readonly actions?: {
    readonly choices?: readonly ChoiceDefinition[];
    readonly commands?: readonly CommandDefinition[];
  };
  readonly lifecycle?: {
    readonly entry?: LifecycleEffects;
    readonly revisit?: LifecycleEffects;
    readonly exit?: LifecycleEffects;
  };
  readonly state?: ScalarRecord;
  readonly ruleIds?: readonly RuleId[];
}

export interface NavigationEdge {
  readonly id: StableId;
  readonly fromNodeId: NodeId;
  readonly toNodeId: NodeId;
  readonly condition?: Condition;
}

export interface EntityDefinition {
  readonly id: StableId;
  readonly name: TextSource;
  readonly fields: readonly StateFieldDefinition[];
  readonly allowedTags: readonly string[];
}

export interface EntityInstance {
  readonly id: EntityId;
  readonly definitionId: StableId;
  readonly name: TextSource;
  readonly tags: readonly string[];
  readonly state: ScalarRecord;
}

export interface EventDefinition {
  readonly id: EventId;
  readonly payloadFields: readonly StateFieldDefinition[];
}

export type RuleTrigger =
  | { readonly kind: 'event'; readonly eventId: EventId }
  | { readonly kind: 'phase'; readonly phase: 'action-start' | 'node-entry' | 'node-revisit' | 'node-exit' | 'time-advanced' };

export interface RuleDefinition {
  readonly id: RuleId;
  readonly trigger: RuleTrigger;
  readonly priority: number;
  readonly condition?: Condition;
  readonly effects: readonly Effect[];
}

export interface DialogueOption {
  readonly id: StableId;
  readonly text: TextSource;
  readonly condition?: Condition;
  readonly falsePolicy?: 'hide' | 'disable';
  readonly nextLineId?: DialogueLineId;
  readonly effects: readonly Effect[];
}

export interface DialogueLine {
  readonly id: DialogueLineId;
  readonly speakerEntityId: EntityId;
  readonly text: TextSource;
  readonly condition?: Condition;
  readonly options?: readonly DialogueOption[];
  readonly nextLineId?: DialogueLineId;
}

export interface ConversationDefinition {
  readonly id: ConversationId;
  readonly participantEntityIds: readonly EntityId[];
  readonly entryLineId: DialogueLineId;
  readonly interruptible: boolean;
  readonly resumeOnReturn: boolean;
  readonly lines: readonly DialogueLine[];
}

export interface ItemDefinition {
  readonly id: ItemId;
  readonly name: TextSource;
  readonly stackLimit: number;
  readonly canContain: boolean;
  readonly useEventId?: EventId;
  readonly equipmentSlot?: StableId;
  readonly fields: readonly StateFieldDefinition[];
}

export interface InventoryStack {
  readonly owner: StateScope;
  readonly itemId: ItemId;
  readonly quantity: number;
  readonly containerItemId?: ItemId;
  readonly equippedSlot?: StableId;
  readonly fields: ScalarRecord;
}

export interface TimeSettings {
  readonly mode: 'per-action' | 'elapsed';
  readonly millisecondsPerAction?: number;
  readonly hiddenBehavior: 'pause' | 'bounded-catch-up';
  readonly maxCatchUpMilliseconds: number;
  readonly showClockHud: boolean;
}

export type RandomnessMode = 'seeded' | 'unseeded';

export interface RandomnessSettings {
  readonly mode: RandomnessMode;
}

export type TypingSoundTarget =
  | { readonly kind: 'key'; readonly code: string }
  | { readonly kind: 'group'; readonly group: 'letters' | 'digits' | 'space' | 'punctuation' | 'editing' | 'other' };

export interface TypingSoundMapping {
  readonly target: TypingSoundTarget;
  readonly assetHash: Sha256Hex;
  readonly volume: number;
}

export type TypingSoundFallback =
  | { readonly kind: 'silent' }
  | { readonly kind: 'asset'; readonly assetHash: Sha256Hex; readonly volume: number };

export interface TypingSounds {
  readonly mappings: readonly TypingSoundMapping[];
  readonly fallback: TypingSoundFallback;
}

export interface SaveSlotPolicy {
  readonly enabled: boolean;
  readonly slotCount: number;
  readonly allowedLocation: 'anywhere' | 'checkpoint';
  readonly checkpointNodeIds?: readonly NodeId[];
}

export interface WorldSettings {
  readonly time: TimeSettings;
  readonly randomness: RandomnessSettings;
  readonly typingSounds?: TypingSounds;
  readonly playerStylePath?: VfsPath;
}

export interface ScriptSourceReference {
  readonly id: ScriptId;
  readonly path: VfsPath;
  readonly language: ScriptLanguage;
  readonly entrypoint: 'main';
}

export interface WorldDocument {
  readonly format: 'dungeon-scrivener-world';
  readonly schemaVersion: SchemaVersion;
  readonly entryNodeId: NodeId;
  readonly settings: WorldSettings;
  readonly savePolicy: SaveSlotPolicy;
  readonly stateDefinitions: readonly (StateFieldDefinition & { readonly scopeKind: 'world' | 'node' })[];
  readonly worldState: ScalarRecord;
  readonly nodes: readonly NodeDefinition[];
  readonly navigationEdges: readonly NavigationEdge[];
  readonly entityDefinitions: readonly EntityDefinition[];
  readonly entities: readonly EntityInstance[];
  readonly actionDefaults: ActionSet;
  readonly eventDefinitions: readonly EventDefinition[];
  readonly rules: readonly RuleDefinition[];
  readonly conversations: readonly ConversationDefinition[];
  readonly itemDefinitions: readonly ItemDefinition[];
  readonly initialInventory: readonly InventoryStack[];
  readonly scripts: readonly ScriptSourceReference[];
}

export type ScriptLanguage = 'javascript' | 'lua' | 'python';

export interface SourceSpan {
  readonly path: VfsPath;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface ScriptIR {
  readonly format: 'dungeon-scrivener-script-ir';
  readonly schemaVersion: SchemaVersion;
  readonly scriptId: ScriptId;
  readonly sourceLanguage: ScriptLanguage;
  readonly sourcePath: VfsPath;
  readonly entrypoint: 'main';
  readonly functions: readonly ScriptFunction[];
}

export interface CompiledScriptBundle {
  readonly format: 'dungeon-scrivener-compiled-script-bundle';
  readonly schemaVersion: SchemaVersion;
  readonly scripts: readonly ScriptIR[];
}

export interface ScriptFunction {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: readonly ScriptStatement[];
  readonly span: SourceSpan;
}

export type ScriptExpression =
  | { readonly kind: 'literal'; readonly value: Scalar; readonly span: SourceSpan }
  | { readonly kind: 'local'; readonly name: string; readonly span: SourceSpan }
  | { readonly kind: 'array'; readonly items: readonly ScriptExpression[]; readonly span: SourceSpan }
  | { readonly kind: 'map'; readonly entries: readonly { readonly key: string; readonly value: ScriptExpression }[]; readonly span: SourceSpan }
  | { readonly kind: 'index'; readonly target: ScriptExpression; readonly index: ScriptExpression; readonly span: SourceSpan }
  | { readonly kind: 'unary'; readonly operator: 'not' | 'negate'; readonly operand: ScriptExpression; readonly span: SourceSpan }
  | { readonly kind: 'binary'; readonly operator: ScriptBinaryOperator; readonly left: ScriptExpression; readonly right: ScriptExpression; readonly span: SourceSpan }
  | { readonly kind: 'call'; readonly target: { readonly kind: 'helper'; readonly name: string } | { readonly kind: 'capability'; readonly name: ScriptCapabilityName }; readonly arguments: readonly ScriptExpression[]; readonly span: SourceSpan };

export type ScriptBinaryOperator =
  | 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo' | 'concat'
  | 'equal' | 'not-equal' | 'less-than' | 'less-or-equal' | 'greater-than' | 'greater-or-equal'
  | 'and' | 'or';

export type ScriptCapabilityName = 'api.read' | 'api.hasTag' | 'api.request' | 'api.emit' | 'api.randomInt' | 'api.randomFloat' | 'len';

export type ScriptStatement =
  | { readonly kind: 'declare-local'; readonly name: string; readonly mutable: boolean; readonly value: ScriptExpression; readonly span: SourceSpan }
  | { readonly kind: 'assign-local'; readonly name: string; readonly value: ScriptExpression; readonly span: SourceSpan }
  | { readonly kind: 'if'; readonly condition: ScriptExpression; readonly then: readonly ScriptStatement[]; readonly else: readonly ScriptStatement[]; readonly span: SourceSpan }
  | { readonly kind: 'while'; readonly condition: ScriptExpression; readonly body: readonly ScriptStatement[]; readonly span: SourceSpan }
  | { readonly kind: 'expression'; readonly expression: ScriptExpression; readonly span: SourceSpan }
  | { readonly kind: 'return'; readonly value?: ScriptExpression; readonly span: SourceSpan };

export interface Diagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error' | 'fatal';
  readonly message: string;
  readonly path?: VfsPath;
  readonly entityId?: StableId;
  readonly sourceSpan?: SourceSpan;
  readonly suggestedFix?: string;
  readonly blocks?: readonly ('play' | 'export' | 'script-execution')[];
  readonly acknowledgementRequired?: readonly ('save-project' | 'play' | 'export')[];
}

export interface DiagnosticReport {
  readonly format: 'dungeon-scrivener-diagnostics';
  readonly schemaVersion: SchemaVersion;
  readonly diagnostics: readonly Diagnostic[];
}

export type SafeInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'emphasis' | 'strong'; readonly children: readonly SafeInline[] }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'node-link'; readonly nodeId: NodeId; readonly label: string }
  | { readonly kind: 'external-link'; readonly href: string; readonly label: string }
  | { readonly kind: 'asset'; readonly assetId: ContentDigest; readonly mediaType: string; readonly alt: string };

export interface SafeTableBlock {
  readonly kind: 'table';
  readonly header: readonly (readonly SafeInline[])[];
  readonly rows: readonly (readonly (readonly SafeInline[])[])[];
}

export type SafeBlock =
  | { readonly kind: 'paragraph'; readonly children: readonly SafeInline[] }
  | { readonly kind: 'blockquote'; readonly blocks: readonly SafeBlock[] }
  | { readonly kind: 'code-block'; readonly text: string; readonly language?: string }
  | { readonly kind: 'thematic-break' }
  | SafeTableBlock
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: readonly SafeInline[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly SafeBlock[])[] }
  | { readonly kind: 'callout'; readonly tone: 'note' | 'tip' | 'important' | 'warning' | 'caution'; readonly blocks: readonly SafeBlock[] }
  | { readonly kind: 'node-embed'; readonly nodeId: NodeId; readonly blocks: readonly SafeBlock[] };

export interface PlayerChoiceView {
  readonly id: ChoiceId;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

export interface PlayerCommandView {
  readonly id: CommandId;
  readonly patterns: readonly string[];
  readonly parameters: readonly CommandParameterDefinition[];
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

export interface PlayerDialogueView {
  readonly conversationId: ConversationId;
  readonly lineId: DialogueLineId;
  readonly speakerEntityId: EntityId;
  readonly speakerName: string;
  readonly text: string;
  readonly options: readonly PlayerChoiceView[];
  readonly canResume: boolean;
}

export interface PlayerInventoryItemView {
  readonly itemId: ItemId;
  readonly label: string;
  readonly quantity: number;
  readonly containerItemId?: ItemId;
  readonly equipmentSlot?: StableId;
  readonly fields: ScalarRecord;
}

export interface PlayerClockView {
  readonly gameTimeMilliseconds: number;
  readonly display: string;
}

export interface PlayerAssetReference {
  readonly assetId: ContentDigest;
  readonly mediaType: 'audio/wav';
  readonly byteLength: number;
}

export interface PlayerTypingSoundMapping {
  readonly target: TypingSoundTarget;
  readonly asset: PlayerAssetReference;
  readonly volume: number;
}

export type PlayerTypingSoundFallback =
  | { readonly kind: 'silent' }
  | { readonly kind: 'asset'; readonly asset: PlayerAssetReference; readonly volume: number };

export interface PlayerTypingSoundView {
  readonly mappings: readonly PlayerTypingSoundMapping[];
  readonly fallback: PlayerTypingSoundFallback;
}

export interface PlayerView {
  readonly format: 'dungeon-scrivener-player-view';
  readonly schemaVersion: SchemaVersion;
  readonly projectId: ProjectId;
  readonly locale: LocaleTag;
  readonly gameTitle: string;
  readonly currentNode: { readonly id: NodeId; readonly title: string; readonly blocks: readonly SafeBlock[] };
  readonly choices: readonly PlayerChoiceView[];
  readonly commands: readonly PlayerCommandView[];
  readonly dialogue?: PlayerDialogueView;
  readonly inventory?: readonly PlayerInventoryItemView[];
  readonly clock?: PlayerClockView;
  /** Resolved local references; read their bytes through MediaAssetApi. */
  readonly typingSounds: PlayerTypingSoundView;
  readonly diagnostics: readonly Pick<Diagnostic, 'code' | 'severity' | 'message'>[];
}

export type ProjectFileRole = 'manifest' | 'world' | 'locale' | 'script' | 'asset' | 'arbitrary';

export interface ProjectFile {
  readonly path: VfsPath;
  readonly bytes: Uint8Array;
  readonly role: ProjectFileRole;
  readonly mediaType?: string;
}

export interface ProjectVfsSnapshot {
  readonly format: 'dungeon-scrivener-project-vfs-index';
  readonly schemaVersion: SchemaVersion;
  readonly projectId: ProjectId;
  readonly directories: ReadonlySet<VfsPath>;
  readonly files: ReadonlyMap<VfsPath, ProjectFile>;
}

export type ProjectArchiveEntry =
  | { readonly kind: 'file'; readonly compression: 'store' | 'deflate'; readonly path: VfsPath; readonly compressedSize: number; readonly uncompressedSize: number; readonly crc32: string; readonly sha256: Sha256Hex }
  | { readonly kind: 'directory'; readonly path: VfsPath };

export interface ProjectArchiveIndex {
  readonly format: 'dungeon-scrivener-project-archive-index';
  readonly schemaVersion: SchemaVersion;
  readonly archiveVersion: SchemaVersion;
  readonly entries: readonly ProjectArchiveEntry[];
}

export interface FingerprintedFile {
  readonly path: VfsPath;
  readonly byteLength: number;
  readonly sha256: Sha256Hex;
}

export interface ContentFingerprint {
  readonly format: 'dungeon-scrivener-content-fingerprint';
  readonly schemaVersion: SchemaVersion;
  readonly algorithm: 'sha-256';
  readonly scope: 'playable-files-v1';
  readonly digest: ContentDigest;
  readonly files: readonly FingerprintedFile[];
}

export interface RandomOutcome {
  readonly ordinal: number;
  readonly sourceScriptId: ScriptId;
  readonly provider: 'seeded' | 'unseeded';
  readonly operation: 'float' | 'integer';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly value: number;
}

/** Only nondeterministic draws are persisted; seeded draws replay from randomSeed. */
export type UnseededRandomOutcome = Omit<RandomOutcome, 'provider'> & { readonly provider: 'unseeded' };

export interface RandomSeedSource {
  /** Supplies one uniformly distributed uint32 seed. */
  nextUint32(): number;
}

export type RandomOutcomeRequest = Pick<RandomOutcome, 'ordinal' | 'sourceScriptId' | 'operation' | 'minimum' | 'maximum'>;

export interface RandomOutcomeReplaySource {
  /** Returns the recorded value for this exact request, or undefined on exhaustion/mismatch. */
  nextOutcome(request: RandomOutcomeRequest): UnseededRandomOutcome | undefined;
}

export type PageVisibility = 'visible' | 'hidden';

export interface ClockState {
  readonly visibility: PageVisibility;
  readonly focused: boolean;
  /** Host-supplied wall-clock baseline. Null for per-action time worlds. */
  readonly lastObservedEpochMilliseconds: number | null;
  /** Start of the current hidden-or-unfocused interval; null while active. */
  readonly inactiveSinceEpochMilliseconds: number | null;
}

export interface SavedConversationContext {
  readonly conversationId: ConversationId;
  readonly lineId: DialogueLineId;
  readonly returnNodeId: NodeId;
  readonly historyLineIds: readonly DialogueLineId[];
}

export interface SavedSessionState {
  readonly currentNodeId: NodeId;
  readonly state: {
    readonly world: ScalarRecord;
    readonly nodes: Readonly<Record<NodeId, ScalarRecord>>;
    readonly entities: Readonly<Record<EntityId, ScalarRecord>>;
  };
  readonly nodeVisitCounts: Readonly<Record<NodeId, number>>;
  readonly conversationStack: readonly SavedConversationContext[];
  readonly gameTimeMilliseconds: number;
  readonly randomnessMode: RandomnessMode;
  /** Normalized seed used to initialize the session; null in unseeded mode. */
  readonly randomInitialSeed: number | null;
  /** Current xorshift32 state needed to continue seeded randomness; null when unseeded. */
  readonly randomSeed: number | null;
  readonly randomOutcomes: readonly UnseededRandomOutcome[];
  /** Mutable tags, including authored initial tags plus accepted tag effects. */
  readonly entityTags: Readonly<Record<EntityId, readonly string[]>>;
  readonly clockState: ClockState;
  readonly ruleGuards: Readonly<Record<RuleId, boolean>>;
  readonly inventory: readonly InventoryStack[];
}

export interface PlayerSaveArchive {
  readonly format: 'dungeon-scrivener-player-save';
  readonly schemaVersion: SchemaVersion;
  readonly projectId: ProjectId;
  readonly gameVersion: GameVersion;
  readonly engineVersion: string;
  readonly contentFingerprint: ContentDigest;
  readonly slotId: StableId;
  readonly slotLabel?: string;
  readonly savedAt: string;
  readonly session: SavedSessionState;
}

export interface ArchiveLimits {
  readonly maxArchiveBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxEntryBytes: number;
  readonly maxEntries: number;
  readonly maxPathBytes: number;
}

/** Resolved action input. Player text enters through PlayerInput instead. */
export type ActionInput =
  | { readonly kind: 'choice'; readonly actionId: ChoiceId }
  | { readonly kind: 'command'; readonly actionId: CommandId; readonly parameters: Readonly<Record<string, Scalar>> };

export type PlayerInput =
  | { readonly kind: 'choice'; readonly actionId: ChoiceId }
  | { readonly kind: 'command-text'; readonly rawText: string };

export type CommandMatchResult =
  | {
      readonly kind: 'matched';
      readonly action: Extract<ActionInput, { readonly kind: 'command' }>;
      readonly normalizedText: string;
    }
  | { readonly kind: 'no-match'; readonly normalizedText: string }
  | { readonly kind: 'ambiguous'; readonly commandIds: readonly CommandId[]; readonly normalizedText: string }
  | { readonly kind: 'invalid-input'; readonly diagnostic: Diagnostic };

export type PlayerInputResolution =
  | { readonly kind: 'choice'; readonly actionId: ChoiceId }
  | { readonly kind: 'command'; readonly action: Extract<ActionInput, { readonly kind: 'command' }>; readonly normalizedText: string }
  | { readonly kind: 'no-match'; readonly normalizedText: string }
  | { readonly kind: 'ambiguous'; readonly commandIds: readonly CommandId[]; readonly normalizedText: string }
  | { readonly kind: 'invalid-input'; readonly diagnostic: Diagnostic }
  | { readonly kind: 'disabled'; readonly actionId: StableId; readonly reason: string };

export interface SessionStartOptions {
  /** Optional seeded-mode override. If absent the host's seededSeedSource is used. */
  readonly randomSeed?: number;
  readonly wallClockEpochMilliseconds: number;
  readonly visibility: PageVisibility;
  readonly focused: boolean;
}

export type SessionCreationResult =
  | { readonly ok: true; readonly snapshot: SessionSnapshot }
  | { readonly ok: false; readonly diagnostics: DiagnosticReport };

export interface ClockInput {
  readonly kind: 'tick' | 'visibility-change' | 'focus-change' | 'resume';
  readonly wallClockEpochMilliseconds: number;
  readonly visibility: PageVisibility;
  readonly focused: boolean;
}

export interface RandomEntropySource {
  /** Supplies one uniformly distributed uint32 value from the host entropy source. */
  nextUint32(): number;
}

export type ScriptInvocationOrigin =
  | { readonly kind: 'action'; readonly actionId: StableId }
  | { readonly kind: 'rule'; readonly ruleId: RuleId }
  | { readonly kind: 'lifecycle'; readonly nodeId: NodeId; readonly phase: 'entry' | 'revisit' | 'exit' };

export interface ScriptExecutionCapabilities {
  read(reference: StateReference): Scalar;
  hasTag(entityId: EntityId, tag: string): boolean;
  request(effect: ScriptEffect): void;
  emit(eventId: EventId, payload: JsonRecord): void;
  randomInt(minimum: number, maximum: number): number;
  randomFloat(): number;
}

/** Thrown by an engine capability callback when an operation is rejected or a budget is exhausted. */
export interface ScriptCapabilityError extends Error {
  readonly diagnostic: Diagnostic;
}

export interface ScriptExecutionLimits {
  /** Already clamped to both the activation budget and remaining action budget. */
  readonly maxInstructions: number;
  readonly maxCallDepth: number;
  readonly maxLoopIterations: number;
  readonly maxAllocatedBytes: number;
  readonly maxStringBytes: number;
  readonly maxCollectionMembers: number;
  readonly maxValueDepth: number;
  /** Remaining action-wide budgets, enforced again by the engine. */
  readonly maxCapabilityCalls: number;
  readonly maxRequestedEffects: number;
  readonly maxTraceRecords: number;
}

export interface ScriptExecutionContext {
  readonly origin: ScriptInvocationOrigin;
  readonly limits: ScriptExecutionLimits;
  readonly capabilities: ScriptExecutionCapabilities;
}

export interface ScriptExecutionTraceRecord {
  readonly sequence: number;
  readonly scriptId: ScriptId;
  readonly kind: 'activation-start' | 'capability-call' | 'activation-end' | 'failure';
  readonly sourceSpan?: SourceSpan;
  readonly capability?: ScriptCapabilityName;
  readonly instructionsExecuted?: number;
  readonly reason: string;
}

export type ScriptExecutionResult =
  | { readonly ok: true; readonly instructionsExecuted: number; readonly trace: readonly ScriptExecutionTraceRecord[] }
  | { readonly ok: false; readonly instructionsExecuted: number; readonly diagnostic: Diagnostic; readonly trace: readonly ScriptExecutionTraceRecord[] };

export interface ScriptExecutorApi {
  /** Synchronous single activation. Capabilities bridge into the engine's provisional transaction. */
  executeScript(script: ScriptIR, context: ScriptExecutionContext): ScriptExecutionResult;
}

export interface ResolvedMediaAsset {
  readonly assetId: ContentDigest;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

export type MediaAssetResolution =
  | { readonly ok: true; readonly asset: ResolvedMediaAsset }
  | { readonly ok: false; readonly diagnostic: Diagnostic };

export interface MediaAssetApi {
  /** Resolves by content hash, verifies bytes and returns them without exposing project paths. */
  resolveAsset(assetId: ContentDigest): MediaAssetResolution;
}

export interface GameEngineHost {
  readonly scriptExecutor: ScriptExecutorApi;
  readonly mediaAssets: MediaAssetApi;
  /** Used only when seeded mode has no explicit session seed. */
  readonly seededSeedSource?: RandomSeedSource;
  /** Used only by unseeded random calls. */
  readonly unseededRandomSource?: RandomEntropySource;
  /** When supplied, replaces entropy and validates requests against a saved outcome log. */
  readonly unseededRandomReplaySource?: RandomOutcomeReplaySource;
}

export interface SessionSnapshot extends SavedSessionState {
  readonly projectId: ProjectId;
}

export type TraceSource =
  | { readonly kind: 'action'; readonly actionId: StableId }
  | { readonly kind: 'rule'; readonly ruleId: RuleId }
  | { readonly kind: 'lifecycle'; readonly nodeId: NodeId; readonly phase: 'entry' | 'revisit' | 'exit' }
  | { readonly kind: 'script'; readonly scriptId: ScriptId }
  | { readonly kind: 'engine'; readonly operation: string };

export interface TransitionTraceRecord {
  readonly sequence: number;
  readonly kind:
    | 'action'
    | 'condition'
    | 'effect-request'
    | 'state-change'
    | 'event'
    | 'rule'
    | 'node-transition'
    | 'time'
    | 'random'
    | 'script'
    | 'diagnostic';
  readonly source: TraceSource;
  readonly reason: string;
  readonly target?: StateReference;
  readonly effect?: Effect;
  readonly eventId?: EventId;
  readonly fromNodeId?: NodeId;
  readonly toNodeId?: NodeId;
  readonly before?: Scalar;
  readonly after?: Scalar;
  readonly randomOutcome?: RandomOutcome;
  readonly scriptTrace?: ScriptExecutionTraceRecord;
  readonly diagnosticCode?: string;
}

export interface TransitionResult {
  readonly snapshot: SessionSnapshot;
  readonly trace: readonly TransitionTraceRecord[];
  readonly diagnostics: DiagnosticReport;
}

export interface PlayerInputTransitionResult extends TransitionResult {
  readonly resolution: PlayerInputResolution;
}

export interface ContentFingerprintResult {
  readonly ok: true;
  readonly value: ContentFingerprint;
}

export interface ContentFingerprintFailure {
  readonly ok: false;
  readonly diagnostics: DiagnosticReport;
}

/** Public package API ownership is fixed in docs/contracts/package-apis.md. */
export interface ProjectModelApi {
  validateProject(
    snapshot: ProjectVfsSnapshot,
    manifest: ProjectManifest,
    world: WorldDocument,
    locales: readonly LocaleDocument[]
  ): DiagnosticReport;
  computeContentFingerprint(
    snapshot: ProjectVfsSnapshot,
    manifest: ProjectManifest,
    world: WorldDocument,
    locales: readonly LocaleDocument[]
  ): ContentFingerprintResult | ContentFingerprintFailure;
}

export interface ProjectVfsApi {
  createSnapshot(files: Iterable<ProjectFile>, directories?: Iterable<VfsPath>): ProjectVfsSnapshot;
  readProjectZip(bytes: Uint8Array, limits?: ArchiveLimits): Promise<ProjectVfsSnapshot>;
  writeProjectZip(snapshot: ProjectVfsSnapshot): Promise<Uint8Array>;
}

export interface GameEngineApi {
  createSession(projectId: ProjectId, world: WorldDocument, options: SessionStartOptions): SessionCreationResult;
  matchCommandText(world: WorldDocument, snapshot: SessionSnapshot, rawText: string): CommandMatchResult;
  dispatchPlayerInput(world: WorldDocument, snapshot: SessionSnapshot, input: PlayerInput): PlayerInputTransitionResult;
  observeClock(world: WorldDocument, snapshot: SessionSnapshot, input: ClockInput): TransitionResult;
  /** Engine-level dispatch for already-resolved choices and command captures. */
  dispatchAction(world: WorldDocument, snapshot: SessionSnapshot, input: ActionInput): TransitionResult;
  getPlayerView(
    manifest: ProjectManifest,
    world: WorldDocument,
    locales: readonly LocaleDocument[],
    snapshot: SessionSnapshot,
    requestedLocale?: LocaleTag
  ): PlayerView;
}

export interface GameEngineFactoryApi {
  createGameEngine(host: GameEngineHost, scripts: CompiledScriptBundle): GameEngineApi;
}

export interface ScriptCompilerApi {
  compileScript(source: string, reference: ScriptSourceReference): ScriptIR | DiagnosticReport;
}

export interface SaveCompatibilityTarget {
  readonly manifest: Pick<ProjectManifest, 'projectId' | 'gameVersion'>;
  readonly engineVersion: string;
  readonly contentFingerprint: ContentDigest;
}

export type SaveCompatibilityMismatch = 'projectId' | 'gameVersion' | 'engineVersion' | 'contentFingerprint';

export type SaveCompatibilityResult =
  | { readonly compatible: true; readonly mismatches: readonly [] }
  | { readonly compatible: false; readonly mismatches: readonly [SaveCompatibilityMismatch, ...SaveCompatibilityMismatch[]] };

export type PlayerSaveEncodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly operation: 'encode'; readonly diagnostics: DiagnosticReport };

export type PlayerSaveDecodeResult =
  | { readonly ok: true; readonly save: PlayerSaveArchive }
  | { readonly ok: false; readonly operation: 'decode'; readonly diagnostics: DiagnosticReport };

export interface PlayerSaveApi {
  encodePlayerSave(save: PlayerSaveArchive): Promise<PlayerSaveEncodeResult>;
  decodePlayerSave(bytes: Uint8Array): Promise<PlayerSaveDecodeResult>;
  checkSaveCompatibility(save: PlayerSaveArchive, target: SaveCompatibilityTarget): SaveCompatibilityResult;
}
