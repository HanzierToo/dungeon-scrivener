import type {
  DiagnosticReport,
  GameEngineApi,
  LocaleTag,
  LocaleDocument,
  PlayerInput,
  PlayerInputTransitionResult,
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
  const view = snapshot && !startupFailure
    ? engine.getPlayerView(manifest, world, locales, snapshot, requestedLocale)
    : undefined;

  function submit(input: PlayerInput): PlayerInputTransitionResult | undefined {
    if (!snapshot || startupFailure) return undefined;
    const result = engine.dispatchPlayerInput(world, snapshot, input);
    if (!result.diagnostics.diagnostics.some(diagnostic => diagnostic.severity === 'error' || diagnostic.severity === 'fatal')) {
      onSnapshot(result.snapshot);
    }
    return result;
  }

  return <Player {...playerProps} locales={localeOptions ?? []} view={view} startupFailure={startupFailure} onInput={submit} />;
}
