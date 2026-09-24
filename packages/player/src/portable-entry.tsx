import { createRoot, type Root } from 'react-dom/client';
import type {
  CompiledScriptBundle,
  DiagnosticReport,
  GameEngineApi,
  GameEngineFactoryApi,
  GameEngineHost,
  LocaleDocument,
  ProjectManifest,
  SessionSnapshot,
  SessionStartOptions,
  WorldDocument,
} from '@dungeon-scrivener/model';
import { EnginePlayer, type EnginePlayerProps } from './EnginePlayer.js';
import { Player } from './Player.js';
import * as engine from '@dungeon-scrivener/engine';

export { engine };

export interface PortableGameData {
  readonly manifest: ProjectManifest;
  readonly world: WorldDocument;
  readonly locales: readonly LocaleDocument[];
  readonly compiledScripts: CompiledScriptBundle;
  readonly sessionStart: SessionStartOptions;
}

export interface PortableStartOptions {
  readonly factory: GameEngineFactoryApi;
  readonly host: Omit<GameEngineHost, 'scriptExecutor'>;
  readonly localeOptions?: EnginePlayerProps['localeOptions'];
  readonly themeCss?: string;
  readonly onLocaleChange?: EnginePlayerProps['onLocaleChange'];
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
      mediaAssets={this.options.host.mediaAssets}
      {...(this.options.themeCss ? { themeCss: this.options.themeCss } : {})}
      onLocaleChange={locale => { this.requestedLocale = locale; this.options.onLocaleChange?.(locale); this.render(); }}
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
