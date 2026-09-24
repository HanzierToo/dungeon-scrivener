import { describe, expect, it } from 'vitest';
import type { LocaleDocument, ProjectManifest, SessionSnapshot, WorldDocument } from '@dungeon-scrivener/model';
import tavernManifestJson from '../../../../fixtures/tavern-at-dusk/project.json';
import tavernWorldJson from '../../../../fixtures/tavern-at-dusk/world.json';
import enGbJson from '../../../../fixtures/tavern-at-dusk/locales/en-GB.json';
import jaJpJson from '../../../../fixtures/tavern-at-dusk/locales/ja-JP.json';
import { dispatchPlayerInput, enterSessionNode } from '../core/actions.js';
import { createInitialState } from '../core/state.js';
import { processEventQueue, processRulePhase } from '../core/rules.js';
import { projectDialogueView } from './index.js';

const manifest = tavernManifestJson as unknown as ProjectManifest;
const baseWorld = tavernWorldJson as unknown as WorldDocument;
const locales = [enGbJson, jaJpJson] as unknown as readonly LocaleDocument[];

function makeWorld(world: WorldDocument = baseWorld): WorldDocument {
  return { ...world, scripts: [] };
}

function makeSnapshot(world: WorldDocument, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const snapshot: SessionSnapshot = {
    projectId: 'tavern-at-dusk',
    currentNodeId: 'taproom',
    state: createInitialState(world),
    nodeVisitCounts: Object.fromEntries(world.nodes.map((node) => [node.id, node.id === 'taproom' ? 1 : 0])),
    activeConversation: null,
    conversationStack: [],
    dialogueHistory: [],
    gameTimeMilliseconds: 120_000,
    randomnessMode: 'unseeded',
    randomInitialSeed: null,
    randomSeed: null,
    randomOutcomes: [],
    entityTags: Object.fromEntries(world.entities.map((entity) => [entity.id, [...entity.tags]])),
    clockState: { visibility: 'visible', focused: true, lastObservedEpochMilliseconds: 1_360_000, inactiveSinceEpochMilliseconds: null },
    ruleGuards: Object.fromEntries(world.rules.map((rule) => [rule.id, false])),
    inventory: [...world.initialInventory],
    nextInventoryStackOrdinal: 0,
  };
  return { ...snapshot, ...overrides };
}

function run(world: WorldDocument, snapshot: SessionSnapshot, input: Parameters<typeof dispatchPlayerInput>[2]) {
  const result = dispatchPlayerInput(world, snapshot, input);
  expect(result.diagnostics.diagnostics).toEqual([]);
  return result;
}

describe('dialogue engine', () => {
  it('plays Tavern at Dusk through interruption, changed trust, resume, and inventory reward', () => {
    const world = makeWorld({
      ...baseWorld,
      nodes: baseWorld.nodes.map((node) => node.id === 'taproom' ? {
        ...node,
        actions: {
          ...node.actions,
          choices: [...(node.actions?.choices ?? []), {
            id: 'raise-trust', label: { kind: 'literal', text: 'Raise trust' }, effects: [{
              kind: 'set-state', target: { scope: { kind: 'world' }, key: 'trust' }, value: 1,
            }],
          }],
        },
      } : node),
    });
    const initial = makeSnapshot(world);
    const started = run(world, initial, { kind: 'command-text', rawText: 'speak with Mira' });
    expect(started.snapshot.activeConversation).toMatchObject({ conversationId: 'mira-story', lineId: 'mira-first' });
    expect(projectDialogueView(manifest, world, locales, started.snapshot)?.speakerName).toBe('Mira');
    expect(started.snapshot.dialogueHistory).toContainEqual({ kind: 'line-seen', conversationId: 'mira-story', lineId: 'mira-first' });

    const interrupted = run(world, started.snapshot, {
      kind: 'dialogue-option', conversationId: 'mira-story', lineId: 'mira-first', optionId: 'interrupt-for-rowan',
    });
    expect(interrupted.snapshot.activeConversation).toMatchObject({ conversationId: 'rowan-story', lineId: 'rowan-first' });
    expect(interrupted.snapshot.conversationStack).toEqual([{ conversationId: 'mira-story', lineId: 'mira-after-return', returnNodeId: 'taproom' }]);
    expect(projectDialogueView(manifest, world, locales, interrupted.snapshot)?.options).toEqual([]);

    const trustRaised = run(world, interrupted.snapshot, { kind: 'choice', actionId: 'raise-trust' });
    expect(trustRaised.snapshot.activeConversation).toEqual(interrupted.snapshot.activeConversation);
    expect(trustRaised.snapshot.state.world['trust']).toBe(1);
    expect(projectDialogueView(manifest, world, locales, trustRaised.snapshot)?.options.map((option) => option.id)).toContain('tell-secret');

    const secret = run(world, trustRaised.snapshot, {
      kind: 'dialogue-option', conversationId: 'rowan-story', lineId: 'rowan-first', optionId: 'tell-secret',
    });
    expect(secret.snapshot.activeConversation).toMatchObject({ conversationId: 'rowan-story', lineId: 'rowan-secret' });
    expect(projectDialogueView(manifest, world, locales, secret.snapshot)?.speakerName).toBe('Rowan');
    expect(secret.snapshot.dialogueHistory).toContainEqual({ kind: 'option-selected', conversationId: 'rowan-story', lineId: 'rowan-first', optionId: 'tell-secret' });
    expect(secret.snapshot.dialogueHistory).toContainEqual({ kind: 'line-seen', conversationId: 'rowan-story', lineId: 'rowan-secret' });

    const returned = run(world, secret.snapshot, {
      kind: 'dialogue-option', conversationId: 'rowan-story', lineId: 'rowan-secret', optionId: 'return-to-mira',
    });
    expect(returned.snapshot.activeConversation).toMatchObject({ conversationId: 'mira-story', lineId: 'mira-after-return' });
    expect(returned.snapshot.conversationStack).toEqual([]);

    const reward = run(world, returned.snapshot, {
      kind: 'dialogue-option', conversationId: 'mira-story', lineId: 'mira-after-return', optionId: 'claim-silver-key',
    });
    expect(reward.snapshot.activeConversation).toBeNull();
    expect(reward.snapshot.inventory).toContainEqual(expect.objectContaining({ itemId: 'silver-key', quantity: 1 }));
    const reloaded = JSON.parse(JSON.stringify(reward.snapshot)) as SessionSnapshot;
    expect(reloaded.dialogueHistory).toEqual(reward.snapshot.dialogueHistory);
    expect(reloaded.conversationStack).toEqual([]);
  });


  it('suspends on navigation and resumes the matching context after destination effects and rules', () => {
    const world = makeWorld(baseWorld);
    const active = makeSnapshot(world, {
      activeConversation: { conversationId: 'mira-story', lineId: 'mira-first', returnNodeId: 'taproom' },
    });
    const left = dispatchPlayerInput(world, active, { kind: 'choice', actionId: 'enter-cellar' });
    expect(left.diagnostics.diagnostics).toEqual([]);
    expect(left.snapshot.currentNodeId).toBe('cellar');
    expect(left.snapshot.activeConversation).toBeNull();
    expect(left.snapshot.conversationStack).toEqual([{ conversationId: 'mira-story', lineId: 'mira-first', returnNodeId: 'taproom' }]);

    const returned = dispatchPlayerInput(world, left.snapshot, { kind: 'choice', actionId: 'return-to-taproom' });
    expect(returned.diagnostics.diagnostics).toEqual([]);
    expect(returned.snapshot.currentNodeId).toBe('taproom');
    expect(returned.snapshot.activeConversation).toMatchObject({ conversationId: 'mira-story', lineId: 'mira-first' });
    expect(returned.snapshot.conversationStack).toEqual([]);
  });

  it('starts conversations from event-triggered rules as well as phase-triggered rules', () => {
    const world = makeWorld({
      ...baseWorld,
      eventDefinitions: [...baseWorld.eventDefinitions, { id: 'dialogue-trigger', payloadFields: [] }],
      rules: [{ id: 'event-dialogue', trigger: { kind: 'event', eventId: 'dialogue-trigger' }, priority: 1, effects: [{ kind: 'start-conversation', conversationId: 'rowan-story' }] }],
      nodes: baseWorld.nodes.map((node) => node.id === 'taproom' ? { ...node, ruleIds: ['event-dialogue'] } : node),
    });
    const initial = makeSnapshot(world);
    const started = processEventQueue(world, initial, [{ eventId: 'dialogue-trigger', payload: {}, source: 'test' }], { kind: 'engine', operation: 'test-event' }, 'Test event rule.');
    expect(started.diagnostics.diagnostics).toEqual([]);
    expect(started.snapshot.activeConversation).toMatchObject({ conversationId: 'rowan-story', lineId: 'rowan-first' });
  });

  it('projects hidden and disabled options with the authored localized reason and consumes no time when disabled', () => {
    const world = makeWorld(baseWorld);
    const active = makeSnapshot(world, {
      activeConversation: { conversationId: 'mira-story', lineId: 'mira-after-return', returnNodeId: 'taproom' },
    });
    const view = projectDialogueView(manifest, world, locales, active, 'en-GB');
    expect(view?.options.map((option) => option.id)).not.toContain('claim-silver-key');
    expect(view?.options).toContainEqual(expect.objectContaining({
      id: 'show-key', enabled: false, disabledReason: 'You need to carry the silver key.',
    }));
    const disabled = dispatchPlayerInput(world, active, {
      kind: 'dialogue-option', conversationId: 'mira-story', lineId: 'mira-after-return', optionId: 'show-key',
    });
    expect(disabled.resolution).toMatchObject({ kind: 'dialogue-option-disabled', disabledReason: '[disabled-reason-key-needed]' });
    expect(disabled.snapshot).toBe(active);
    expect(disabled.snapshot.gameTimeMilliseconds).toBe(active.gameTimeMilliseconds);
  });


  it('resolves conditional lines against actor traits and routes choice and lifecycle effects', () => {
    const world = makeWorld({
      ...baseWorld,
      conversations: baseWorld.conversations.map((conversation) => conversation.id === 'mira-story' ? {
        ...conversation,
        lines: [
          ...conversation.lines.map((line) => line.id === 'mira-first' ? {
            ...line,
            condition: {
              kind: 'compare-state' as const,
              left: { scope: { kind: 'entity' as const, ownerId: 'keeper-mira' }, key: 'disposition' },
              operator: 'eq' as const,
              right: 'welcoming',
            },
            nextLineId: 'mira-fallback',
          } : line),
          {
            id: 'mira-fallback', speakerEntityId: 'keeper-mira', text: { kind: 'literal', text: 'A guarded greeting.' },
            options: [{ id: 'fallback-reply', text: { kind: 'literal', text: 'Reply' }, effects: [] }],
          },
        ],
      } : conversation),
      nodes: baseWorld.nodes.map((node) => node.id === 'taproom' ? {
        ...node,
        actions: {
          ...node.actions,
          choices: [...(node.actions?.choices ?? []), {
            id: 'start-via-choice', label: { kind: 'literal', text: 'Speak to Mira' },
            effects: [{ kind: 'start-conversation' as const, conversationId: 'mira-story' }],
          }],
        },
        lifecycle: {
          ...node.lifecycle,
          entry: { policy: 'first-time' as const, effects: [{ kind: 'start-conversation' as const, conversationId: 'mira-story' }] },
        },
      } : node),
    });
    const initial = makeSnapshot(world, {
      state: {
        ...createInitialState(world),
        entities: { ...createInitialState(world).entities, 'keeper-mira': { disposition: 'guarded' } },
      },
    });
    const startedByChoice = dispatchPlayerInput(world, initial, { kind: 'choice', actionId: 'start-via-choice' });
    expect(startedByChoice.diagnostics.diagnostics).toEqual([]);
    expect(startedByChoice.snapshot.activeConversation?.lineId).toBe('mira-fallback');
    expect(startedByChoice.snapshot.dialogueHistory).not.toContainEqual({ kind: 'line-seen', conversationId: 'mira-story', lineId: 'mira-first' });
    expect(projectDialogueView(manifest, world, locales, startedByChoice.snapshot)?.speakerName).toBe('Mira');

    const lifecycleStart = enterSessionNode(world, makeSnapshot(world, {
      state: initial.state,
      nodeVisitCounts: Object.fromEntries(world.nodes.map((node) => [node.id, 0])),
    }));
    expect(lifecycleStart.diagnostics.diagnostics).toEqual([]);
    expect(lifecycleStart.snapshot.activeConversation?.lineId).toBe('mira-fallback');
  });

  it('starts a conversation from a phase rule and rolls back selected history after a later effect fails', () => {
    const world = makeWorld({
      ...baseWorld,
      rules: [{ id: 'entry-dialogue', trigger: { kind: 'phase', phase: 'node-entry' }, priority: 1, effects: [{ kind: 'start-conversation', conversationId: 'mira-story' }] }],
      nodes: baseWorld.nodes.map((node) => node.id === 'taproom' ? { ...node, ruleIds: ['entry-dialogue'] } : node),
    });
    const initial = makeSnapshot(world);
    const ruled = processRulePhase(world, initial, 'node-entry', { kind: 'engine', operation: 'test-entry' }, 'Test phase rule.');
    expect(ruled.diagnostics.diagnostics).toEqual([]);
    expect(ruled.snapshot.activeConversation).toMatchObject({ conversationId: 'mira-story', lineId: 'mira-first' });

    const active = makeSnapshot(world, {
      state: { ...createInitialState(world), world: { ...createInitialState(world).world, trust: 1 } },
      activeConversation: { conversationId: 'mira-story', lineId: 'mira-after-return', returnNodeId: 'taproom' },
      dialogueHistory: [
        { kind: 'line-seen', conversationId: 'mira-story', lineId: 'mira-after-return' },
        { kind: 'line-seen', conversationId: 'rowan-story', lineId: 'rowan-secret' },
        { kind: 'option-selected', conversationId: 'rowan-story', lineId: 'rowan-first', optionId: 'tell-secret' },
      ],
    });
    const badWorld = makeWorld({
      ...world,
      conversations: world.conversations.map((conversation) => conversation.id === 'mira-story' ? {
        ...conversation,
        lines: conversation.lines.map((line) => line.id === 'mira-after-return' ? {
          ...line,
          options: (line.options ?? []).map((option) => option.id === 'claim-silver-key' ? {
            ...option,
            effects: [
              ...option.effects,
              { kind: 'remove-item', stackId: 'missing-stack', quantity: 1 },
            ],
          } : option),
        } : line),
      } : conversation),
    });
    const rejected = dispatchPlayerInput(badWorld, active, {
      kind: 'dialogue-option', conversationId: 'mira-story', lineId: 'mira-after-return', optionId: 'claim-silver-key',
    });
    expect(rejected.resolution.kind).toBe('invalid-dialogue-option');
    expect(rejected.snapshot).toBe(active);
    expect(rejected.snapshot.activeConversation?.lineId).toBe('mira-after-return');
    expect(rejected.snapshot.dialogueHistory).toHaveLength(active.dialogueHistory.length);
    expect(rejected.snapshot.inventory).toEqual(active.inventory);
  });
});
