import type {
  DiagnosticReport,
  GameEngineApi,
  LocaleTag,
  LocaleDocument,
  PlayerInput,
  PlayerInputTransitionResult,
  PlayerView,
  ProjectManifest,
  SessionSnapshot,
  WorldDocument,
} from '@dungeon-scrivener/model';
import { Player, type PlayerLocaleOption, type PlayerProps } from './Player.js';

export interface EnginePlayerProps extends Omit<PlayerProps, 'view' | 'onInput' | 'startupFailure' | 'locales'> {
  readonly engine: GameEngineApi;
  readonly manifest: ProjectManifest;
  readonly world: WorldDocument;
  readonly locales: readonly LocaleDocument[];
  readonly requestedLocale?: LocaleTag;
  readonly localeOptions?: readonly PlayerLocaleOption[];
  readonly snapshot?: SessionSnapshot;
  readonly startupFailure?: DiagnosticReport;
  readonly onSnapshot: (snapshot: SessionSnapshot) => void;
}

/** Adapts the public engine API while leaving the authoritative snapshot with the host. */
export function EnginePlayer({ engine, manifest, world, locales, requestedLocale, localeOptions, snapshot, startupFailure, onSnapshot, ...playerProps }: EnginePlayerProps) {
  let view: PlayerView | undefined;
  let viewFailure: DiagnosticReport | undefined;
  if (snapshot && !startupFailure) {
    try {
      view = engine.getPlayerView(manifest, world, locales, snapshot, requestedLocale);
    } catch (error) {
      viewFailure = { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics: [{
        code: 'DS-PLAYER-VIEW', severity: 'error',
        message: error instanceof Error ? error.message : 'The current game view could not be rendered.',
        blocks: ['play'],
      }] };
    }
  }

  function submit(input: PlayerInput): PlayerInputTransitionResult | undefined {
    if (!snapshot || startupFailure || viewFailure) return undefined;
    const result = engine.dispatchPlayerInput(world, snapshot, input);
    if (!result.diagnostics.diagnostics.some(diagnostic => diagnostic.severity === 'error' || diagnostic.severity === 'fatal')) {
      onSnapshot(result.snapshot);
    }
    return result;
  }

  return <Player {...playerProps} locales={localeOptions ?? []} view={view} startupFailure={startupFailure ?? viewFailure} onInput={submit} />;
}
