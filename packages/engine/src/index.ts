import type {
  ActionInput, AvailabilityTraceHistory, ClockInput, CompiledScriptBundle, GameEngineApi, GameEngineHost,
  LocaleDocument, LocaleTag, PlayerInput, ProjectId, ProjectManifest, SessionSnapshot, SessionStartOptions,
  WorldDocument,
} from '@dungeon-scrivener/model';
import { dispatchAction, dispatchPlayerInput, inspectActionAvailability, matchCommandText } from './core/actions.js';
import { createScriptExecutionEnvironment } from './core/script-runtime.js';
import { createSession } from './core/session.js';
import { observeClock } from './core/time.js';
import { projectDialogueView } from './dialogue/index.js';
import { getPlayerView } from './player-view.js';

export function createGameEngine(host: GameEngineHost, scripts: CompiledScriptBundle): GameEngineApi {
  const scriptEnvironment = createScriptExecutionEnvironment(host, scripts);
  return {
    createSession(projectId: ProjectId, world: WorldDocument, options: SessionStartOptions) {
      return createSession(host, scripts, projectId, world, options);
    },
    inspectActionAvailability(world: WorldDocument, snapshot: SessionSnapshot, traceHistory?: AvailabilityTraceHistory) {
      return inspectActionAvailability(world, snapshot, traceHistory);
    },
    matchCommandText(world: WorldDocument, snapshot: SessionSnapshot, rawText: string) {
      return matchCommandText(world, snapshot, rawText);
    },
    dispatchPlayerInput(world: WorldDocument, snapshot: SessionSnapshot, input: PlayerInput) {
      return dispatchPlayerInput(world, snapshot, input, scriptEnvironment);
    },
    observeClock(world: WorldDocument, snapshot: SessionSnapshot, input: ClockInput) {
      return observeClock(world, snapshot, input, scriptEnvironment);
    },
    dispatchAction(world: WorldDocument, snapshot: SessionSnapshot, input: ActionInput) {
      return dispatchAction(world, snapshot, input, scriptEnvironment);
    },
    projectDialogueView(manifest: Pick<ProjectManifest, 'defaultLocale'>, world: WorldDocument, locales: readonly LocaleDocument[], snapshot: SessionSnapshot, requestedLocale?: LocaleTag) {
      return projectDialogueView(manifest, world, locales, snapshot, requestedLocale);
    },
    getPlayerView(manifest: ProjectManifest, world: WorldDocument, locales: readonly LocaleDocument[], snapshot: SessionSnapshot, requestedLocale?: LocaleTag) {
      return getPlayerView(manifest, world, locales, snapshot, host.mediaAssets, requestedLocale);
    },
  };
}

export * from './core/index.js';
