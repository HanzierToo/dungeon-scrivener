import type {
  Diagnostic, LocaleDocument, LocaleTag, MediaAssetApi, PlayerTypingSoundView, PlayerView,
  ProjectManifest, SessionSnapshot, TextSource, WorldDocument,
} from '@dungeon-scrivener/model';
import { renderMarkdown } from '../../markdown/src/index.js';
import { contentDigestFromHash, validateTypingSoundAsset } from '../../media/src/index.js';
import { getAvailableActions, inspectActionAvailability, inspectActionOutcomes } from './core/actions.js';
import { clockHudValue } from './core/time.js';
import { projectDialogueView } from './dialogue/index.js';

function freezeDeep<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function localize(source: TextSource, requested: LocaleDocument | undefined, fallback: LocaleDocument | undefined): string {
  if (source.kind === 'literal') return source.text;
  return requested?.strings[source.key] ?? fallback?.strings[source.key] ?? `[${source.key}]`;
}

function playerDiagnostic(diagnostic: Diagnostic): Pick<Diagnostic, 'code' | 'severity' | 'message'> {
  return { code: diagnostic.code, severity: diagnostic.severity, message: diagnostic.message };
}

function displayClock(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function projectTypingSounds(
  world: WorldDocument,
  mediaAssets: MediaAssetApi,
  diagnostics: Pick<Diagnostic, 'code' | 'severity' | 'message'>[],
): PlayerTypingSoundView {
  const settings = world.settings.typingSounds ?? { mappings: [], fallback: { kind: 'silent' as const } };
  const resolve = (hash: string) => {
    const assetId = contentDigestFromHash(hash);
    if (!assetId) {
      diagnostics.push({ code: 'DS-MEDIA-HASH', severity: 'warning', message: 'Typing sound has an invalid asset hash.' });
      return undefined;
    }
    const resolved = validateTypingSoundAsset(mediaAssets.resolveAsset(assetId));
    if (!resolved.ok) {
      diagnostics.push(playerDiagnostic(resolved.diagnostic));
      return undefined;
    }
    return { assetId, mediaType: 'audio/wav' as const, byteLength: resolved.asset.byteLength };
  };

  const mappings = settings.mappings.flatMap((mapping) => {
    const asset = resolve(mapping.assetHash);
    return asset ? [{ target: mapping.target, asset, volume: mapping.volume }] : [];
  });
  const fallback = settings.fallback.kind === 'silent'
    ? { kind: 'silent' as const }
    : (() => {
      const asset = resolve(settings.fallback.assetHash);
      return asset ? { kind: 'asset' as const, asset, volume: settings.fallback.volume } : { kind: 'silent' as const };
    })();
  return { mappings, fallback };
}

export function getPlayerView(
  manifest: ProjectManifest,
  world: WorldDocument,
  locales: readonly LocaleDocument[],
  snapshot: SessionSnapshot,
  mediaAssets: MediaAssetApi,
  requestedLocale?: LocaleTag,
): PlayerView {
  const locale = requestedLocale ?? manifest.defaultLocale;
  const requested = locales.find((candidate) => candidate.locale === locale);
  const fallback = locales.find((candidate) => candidate.locale === manifest.defaultLocale);
  const node = world.nodes.find((candidate) => candidate.id === snapshot.currentNodeId);
  const diagnostics: Pick<Diagnostic, 'code' | 'severity' | 'message'>[] = [];
  let currentNode: PlayerView['currentNode'];
  if (node) {
    const sceneText = snapshot.sceneText?.nodeId === node.id ? snapshot.sceneText : undefined;
    const passages = [sceneText?.text ?? node.content, ...(sceneText?.appended ?? [])];
    const blocks = passages.flatMap((passage, index) => {
      const markdown = renderMarkdown({
        source: localize(passage, requested, fallback),
        path: index === 0 ? `world.nodes.${node.id}.content` : `session.sceneText.appended[${index - 1}]`,
        world, locales, locale, defaultLocale: manifest.defaultLocale, assets: mediaAssets,
      });
      diagnostics.push(...markdown.diagnostics.map(playerDiagnostic));
      return markdown.blocks;
    });
    currentNode = { id: node.id, title: localize(node.title, requested, fallback), blocks };
  } else {
    diagnostics.push({ code: 'DS-ENG-021', severity: 'error', message: `Current node ${snapshot.currentNodeId} is not present in the world.` });
    currentNode = { id: snapshot.currentNodeId, title: snapshot.currentNodeId, blocks: [] };
  }

  const definitions = getAvailableActions(world, snapshot);
  const availability = inspectActionAvailability(world, snapshot);
  const choices = definitions.choices.flatMap((choice) => {
    const status = availability.choices.find((candidate) => candidate.id === choice.id);
    if (!status || status.visibility === 'hidden') return [];
    const selectedEffects = snapshot.activeConversation !== null ? inspectActionOutcomes(world, snapshot, choice.outcomes).selected?.effects ?? choice.effects : choice.effects;
    const conversationAlreadyActive = snapshot.activeConversation !== null && selectedEffects.length === 1 && selectedEffects[0]?.kind === 'start-conversation';
    const enabled = status.enabled && !conversationAlreadyActive;
    return [{
      id: choice.id,
      label: localize(choice.label, requested, fallback),
      enabled,
      ...(!enabled ? { disabledReason: conversationAlreadyActive ? 'Finish the current conversation first.' : 'This choice is currently unavailable.' } : {}),
    }];
  });
  const commands = definitions.commands.flatMap((command) => {
    const status = availability.commands.find((candidate) => candidate.id === command.id);
    if (!status || status.visibility === 'hidden') return [];
    const selectedEffects = snapshot.activeConversation !== null ? inspectActionOutcomes(world, snapshot, command.outcomes).selected?.effects ?? command.effects : command.effects;
    const conversationAlreadyActive = snapshot.activeConversation !== null && selectedEffects.length === 1 && selectedEffects[0]?.kind === 'start-conversation';
    const enabled = status.enabled && !conversationAlreadyActive;
    return [{
      id: command.id,
      patterns: command.patterns,
      parameters: command.parameters,
      enabled,
      ...(!enabled ? { disabledReason: conversationAlreadyActive ? 'Finish the current conversation first.' : 'This command is currently unavailable.' } : {}),
    }];
  });

  const dialogue = projectDialogueView({ defaultLocale: manifest.defaultLocale }, world, locales, snapshot, locale);
  const inventory = snapshot.inventory.map((stack) => {
    const item = world.itemDefinitions.find((candidate) => candidate.id === stack.itemId);
    return {
      stackId: stack.id,
      itemId: stack.itemId,
      owner: stack.owner,
      label: item ? localize(item.name, requested, fallback) : stack.itemId,
      quantity: stack.quantity,
      ...(stack.containerStackId ? { containerStackId: stack.containerStackId } : {}),
      ...(item?.equipmentSlot ? { equipmentSlot: item.equipmentSlot } : {}),
      ...(stack.equippedSlot ? { equippedSlot: stack.equippedSlot } : {}),
      fields: stack.fields,
    };
  });
  const clock = clockHudValue(world, snapshot);
  const typingSounds = projectTypingSounds(world, mediaAssets, diagnostics);
  return freezeDeep({
    format: 'dungeon-scrivener-player-view',
    schemaVersion: 1,
    projectId: snapshot.projectId,
    locale,
    gameTitle: manifest.title,
    currentNode,
    choices,
    commands,
    ...(dialogue ? { dialogue } : {}),
    inventory,
    ...(clock === undefined ? {} : { clock: { gameTimeMilliseconds: clock, display: displayClock(clock) } }),
    typingSounds,
    diagnostics,
  });
}
