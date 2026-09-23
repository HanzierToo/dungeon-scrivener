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

export interface ProjectManifest {
  readonly format: 'dungeon-scrivener-project';
  readonly schemaVersion: SchemaVersion;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly defaultLocale: LocaleTag;
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
  | { readonly kind: 'start-conversation' | 'interrupt-conversation' | 'resume-conversation'; readonly conversationId: ConversationId };

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

export interface SaveSlotPolicy {
  readonly enabled: boolean;
  readonly slotCount: number;
  readonly allowedLocation: 'anywhere' | 'checkpoint';
  readonly checkpointNodeIds?: readonly NodeId[];
}

export interface WorldSettings {
  readonly time: TimeSettings;
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
  readonly sourceScriptId?: ScriptId;
  readonly provider: 'seeded' | 'unseeded';
  readonly operation: 'float' | 'integer';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly value: number;
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
  readonly randomSeed: number | null;
  readonly randomOutcomes: readonly RandomOutcome[];
  readonly ruleGuards: Readonly<Record<RuleId, boolean>>;
  readonly inventory: readonly InventoryStack[];
}

export interface PlayerSaveArchive {
  readonly format: 'dungeon-scrivener-player-save';
  readonly schemaVersion: SchemaVersion;
  readonly projectId: ProjectId;
  readonly gameVersion: string;
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

export interface ActionInput {
  readonly kind: 'choice' | 'command';
  readonly actionId: StableId;
  readonly parameters?: Readonly<Record<string, Scalar>>;
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
  readonly diagnosticCode?: string;
}

export interface TransitionResult {
  readonly snapshot: SessionSnapshot;
  readonly trace: readonly TransitionTraceRecord[];
  readonly diagnostics: DiagnosticReport;
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
  createSession(projectId: ProjectId, world: WorldDocument, seed: number | null): SessionSnapshot;
  dispatchAction(world: WorldDocument, snapshot: SessionSnapshot, input: ActionInput): TransitionResult;
  getPlayerView(
    manifest: ProjectManifest,
    world: WorldDocument,
    locales: readonly LocaleDocument[],
    snapshot: SessionSnapshot,
    requestedLocale?: LocaleTag
  ): PlayerView;
}

export interface ScriptCompilerApi {
  compileScript(source: string, reference: ScriptSourceReference): ScriptIR | DiagnosticReport;
}

export interface SaveCompatibilityTarget {
  readonly projectId: ProjectId;
  readonly gameVersion: string;
  readonly engineVersion: string;
  readonly contentFingerprint: ContentDigest;
}

export type SaveCompatibilityMismatch = 'projectId' | 'gameVersion' | 'engineVersion' | 'contentFingerprint';

export type SaveCompatibilityResult =
  | { readonly compatible: true; readonly mismatches: readonly [] }
  | { readonly compatible: false; readonly mismatches: readonly [SaveCompatibilityMismatch, ...SaveCompatibilityMismatch[]] };

export interface PlayerSaveApi {
  encodePlayerSave(save: PlayerSaveArchive): Promise<Uint8Array>;
  decodePlayerSave(bytes: Uint8Array): Promise<PlayerSaveArchive>;
  checkSaveCompatibility(save: PlayerSaveArchive, target: SaveCompatibilityTarget): SaveCompatibilityResult;
}
