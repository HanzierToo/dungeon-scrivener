import { createRoot, type Root } from 'react-dom/client';
import type {
  CompiledScriptBundle,
  DiagnosticReport,
  GameEngineApi,
  GameEngineFactoryApi,
  GameEngineHost,
  LocaleDocument,
  PlayerSaveArchive,
  ProjectManifest,
  SaveCompatibilityTarget,
  SessionSnapshot,
  SessionStartOptions,
  WorldDocument,
} from '@dungeon-scrivener/model';
import { EnginePlayer, type EnginePlayerProps } from './EnginePlayer.js';
import { Player } from './Player.js';
import * as engine from '@dungeon-scrivener/engine';
import { downloadPlayerSave, getSaveSlotChoices, importPortableSaveFile } from '@dungeon-scrivener/player-save';

export { engine };

export interface PortableGameData {
  readonly manifest: ProjectManifest;
  readonly world: WorldDocument;
  readonly locales: readonly LocaleDocument[];
  readonly compiledScripts: CompiledScriptBundle;
  readonly sessionStart: SessionStartOptions;
  readonly saveCompatibility?: SaveCompatibilityTarget;
}

export interface PortableStartOptions {
  readonly factory: GameEngineFactoryApi;
  readonly host: Omit<GameEngineHost, 'scriptExecutor'>;
  readonly localeOptions?: EnginePlayerProps['localeOptions'];
  readonly themeCss?: string;
  readonly onLocaleChange?: EnginePlayerProps['onLocaleChange'];
  readonly saveCompatibility?: SaveCompatibilityTarget;
}

export interface PortableGameHandle {
  unmount(): void;
  getSnapshot(): SessionSnapshot | undefined;
}

interface ExecutorGlobal {
  readonly ScriptExecutor: new () => GameEngineHost['scriptExecutor'];
}

/** Runtime interfaces for Agent 28's inline data bootstrap. */
export const portablePlayerRuntime = Object.freeze({
  engine,
  Player,
  EnginePlayer,
  startFromEmbeddedData,
  parseEmbeddedData,
});

export function parseEmbeddedData(elementId: string): PortableGameData {
  const element = document.getElementById(elementId);
  if (!element || element.tagName !== 'SCRIPT' || element.getAttribute('type') !== 'application/json') {
    throw new Error(`Embedded game data element '${elementId}' was not found or is not application/json.`);
  }
  const parsed: unknown = JSON.parse(element.textContent ?? '');
  if (!isPortableGameData(parsed)) throw new Error('Embedded game data is malformed or incomplete.');
  return parsed;
}

export function startFromEmbeddedData(
  target: HTMLElement,
  data: PortableGameData,
  options: PortableStartOptions,
): PortableGameHandle {
  const executorGlobal = (globalThis as typeof globalThis & { DungeonScrivenerExecutor?: ExecutorGlobal }).DungeonScrivenerExecutor;
  if (!executorGlobal?.ScriptExecutor) throw new Error('The bundled validated IR executor is unavailable.');

  const scriptExecutor = new executorGlobal.ScriptExecutor();
  const gameEngine = options.factory.createGameEngine({ ...options.host, scriptExecutor }, data.compiledScripts);
  const result = gameEngine.createSession(data.manifest.projectId, data.world, data.sessionStart);
  const root = createRoot(target);
  if (!result.ok) {
    root.render(<Player onInput={() => undefined} startupFailure={result.diagnostics} {...(options.themeCss ? { themeCss: options.themeCss } : {})} />);
    return { unmount: () => root.unmount(), getSnapshot: () => undefined };
  }

  const controller = new PortableGameController(root, gameEngine, data, result.snapshot, options);
  controller.render();
  return controller;
}

class PortableGameController implements PortableGameHandle {
  constructor(
    private readonly root: Root,
    private readonly engineApi: GameEngineApi,
    private readonly data: PortableGameData,
    private snapshot: SessionSnapshot,
    private readonly options: PortableStartOptions,
  ) { this.requestedLocale = data.manifest.defaultLocale; }

  private requestedLocale: string;

  getSnapshot(): SessionSnapshot { return this.snapshot; }
  unmount(): void { this.root.unmount(); }

  render(): void {
    this.root.render(<EnginePlayer
      engine={this.engineApi}
      manifest={this.data.manifest}
      world={this.data.world}
      locales={this.data.locales}
      requestedLocale={this.requestedLocale}
      {...(this.options.localeOptions ? { localeOptions: this.options.localeOptions } : {})}
      snapshot={this.snapshot}
      onSnapshot={snapshot => { this.snapshot = snapshot; this.render(); }}
      saveSlots={getSaveSlotChoices(this.data.world.savePolicy)}
      onSave={slotId => this.save(slotId)}
      {...(getSaveSlotChoices(this.data.world.savePolicy).length > 0 ? { onLoad: (file: File) => { void this.load(file); } } : {})}
      mediaAssets={this.options.host.mediaAssets}
      {...(this.options.themeCss ? { themeCss: this.options.themeCss } : {})}
      onLocaleChange={locale => { this.requestedLocale = locale; this.options.onLocaleChange?.(locale); this.render(); }}
    />);
  }

  private save(slotId: string): Promise<string | undefined> {
    const compatibility = this.options.saveCompatibility ?? this.data.saveCompatibility;
    if (!compatibility) return Promise.resolve('This game does not include save compatibility metadata.');
    const slot = getSaveSlotChoices(this.data.world.savePolicy).find(choice => choice.slotId === slotId);
    if (!slot) return Promise.resolve('That save slot is not enabled for this game.');
    const { projectId: _projectId, ...session } = this.snapshot;
    const archive: PlayerSaveArchive = {
      format: 'dungeon-scrivener-player-save',
      schemaVersion: 1,
      projectId: compatibility.manifest.projectId,
      gameVersion: compatibility.manifest.gameVersion,
      engineVersion: compatibility.engineVersion,
      contentFingerprint: compatibility.contentFingerprint,
      slotId,
      slotLabel: slot.label,
      savedAt: new Date().toISOString(),
      session,
    };
    return downloadPlayerSave(archive, this.data.world.savePolicy, this.snapshot.currentNodeId, `${this.data.manifest.projectId}-${slotId}-save.zip`)
      .then(result => result.ok ? undefined : result.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' '));
  }

  private async load(file: File): Promise<void> {
    const compatibility = this.options.saveCompatibility ?? this.data.saveCompatibility;
    if (!compatibility) { this.reportPersistenceFailure('This game does not include save compatibility metadata.'); return; }
    if (!this.data.world.savePolicy.enabled) { this.reportPersistenceFailure('Player saves are disabled for this game.'); return; }
    try {
      const imported = await importPortableSaveFile(file, compatibility);
      if (!imported.ok) {
        const message = imported.reason === 'decode'
          ? imported.diagnostics.diagnostics.map(item => `${item.code}: ${item.message}`).join(' ')
          : imported.message;
        this.reportPersistenceFailure(message || 'The selected save could not be imported.');
        return;
      }
      const slots = getSaveSlotChoices(this.data.world.savePolicy);
      if (!slots.some(slot => slot.slotId === imported.save.slotId)) {
        this.reportPersistenceFailure('The save slot is not available under this game policy.');
        return;
      }
      this.snapshot = imported.snapshot;
      this.render();
    } catch (error) {
      this.reportPersistenceFailure(error instanceof Error ? error.message : 'The selected save could not be read.');
    }
  }

  private reportPersistenceFailure(message: string): void {
    this.root.render(<EnginePlayer
      engine={this.engineApi} manifest={this.data.manifest} world={this.data.world} locales={this.data.locales}
      requestedLocale={this.requestedLocale} snapshot={this.snapshot} onSnapshot={snapshot => { this.snapshot = snapshot; this.render(); }}
      mediaAssets={this.options.host.mediaAssets} saveSlots={getSaveSlotChoices(this.data.world.savePolicy)}
      onSave={slotId => this.save(slotId)}
      {...(getSaveSlotChoices(this.data.world.savePolicy).length > 0 ? { onLoad: (file: File) => { void this.load(file); } } : {})}
      {...(this.options.themeCss ? { themeCss: this.options.themeCss } : {})}
      {...(this.options.localeOptions ? { localeOptions: this.options.localeOptions } : {})}
      onLocaleChange={locale => { this.requestedLocale = locale; this.options.onLocaleChange?.(locale); this.render(); }}
      persistenceNotice={message}
    />);
  }
}

function isPortableGameData(value: unknown): value is PortableGameData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PortableGameData>;
  return typeof candidate.manifest === 'object' && candidate.manifest !== null
    && typeof candidate.world === 'object' && candidate.world !== null
    && Array.isArray(candidate.locales)
    && typeof candidate.compiledScripts === 'object' && candidate.compiledScripts !== null
    && typeof candidate.sessionStart === 'object' && candidate.sessionStart !== null;
}
