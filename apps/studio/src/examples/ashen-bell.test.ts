import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@dungeon-scrivener/engine';
import { createMediaAssetCatalog } from '@dungeon-scrivener/media';
import { validateProject, type PlayerInput, type SessionSnapshot } from '@dungeon-scrivener/model';
import { scriptExecutor } from '@dungeon-scrivener/scripting';
import { ashenLocale, ashenManifest, ashenWorld } from './ashen-bell.js';

const engine = createGameEngine({ scriptExecutor, mediaAssets: createMediaAssetCatalog(), seededSeedSource: { nextUint32: () => 17 } },
  { format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts: [] });

function advance(snapshot: SessionSnapshot, input: PlayerInput): SessionSnapshot {
  const result = engine.dispatchPlayerInput(ashenWorld, snapshot, input);
  expect(result.diagnostics.diagnostics.filter(item => item.severity === 'error' || item.severity === 'fatal'), JSON.stringify(input)).toEqual([]);
  return result.snapshot;
}

function play(inputs: readonly PlayerInput[]) {
  const started = engine.createSession(ashenManifest.projectId, ashenWorld, { wallClockEpochMilliseconds: 0, visibility: 'visible', focused: true });
  if (!started.ok) throw new Error(JSON.stringify(started.diagnostics.diagnostics));
  let snapshot = started.snapshot;
  for (const input of inputs) snapshot = advance(snapshot, input);
  return snapshot;
}

const choose = (actionId: string): PlayerInput => ({ kind: 'choice', actionId });

describe('The Ashen Bell example', () => {
  it('has valid project documents and all required locale strings', () => {
    const result = validateProject({ manifest: ashenManifest, world: ashenWorld, locales: { 'locales/en-GB.json': ashenLocale } });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.diagnostics.filter(item => item.severity === 'warning')).toEqual([]);
  });

  it('can earn the key through a stateful dialogue and ring the bell', () => {
    const snapshot = play([
      choose('search-archive'), choose('read-ledger'), choose('take-record'), choose('speak-to-keeper'),
      { kind: 'dialogue-option', conversationId: 'keeper-story', lineId: 'keeper-first', optionId: 'show-ledger' },
      { kind: 'dialogue-option', conversationId: 'keeper-story', lineId: 'keeper-trusts', optionId: 'thank-keeper' },
      choose('leave-keeper'), choose('climb-tower'), choose('enter-chamber'), choose('ring-the-bell'),
    ]);
    expect(snapshot.currentNodeId).toBe('bright-ending');
    expect(snapshot.state.world['bell-rung']).toBe(true);
  });

  it('supports the ferryman command and reaches the quiet ending without a key', () => {
    const answer = play([
      choose('visit-ferryman'), { kind: 'command-text', rawText: 'talk to ferryman' },
      { kind: 'dialogue-option', conversationId: 'ferryman-story', lineId: 'ferryman-first', optionId: 'ask-bell' },
    ]);
    const reply = engine.getPlayerView(ashenManifest, ashenWorld, [ashenLocale], answer).dialogue;
    expect(reply?.text).toBe(ashenLocale.strings['ferryman-answer-text']);
    expect(reply?.options.map(option => option.label)).toEqual(['Thank Ivo']);

    const snapshot = play([
      choose('visit-ferryman'), { kind: 'command-text', rawText: 'talk to ferryman' },
      { kind: 'dialogue-option', conversationId: 'ferryman-story', lineId: 'ferryman-first', optionId: 'ask-bell' },
      { kind: 'dialogue-option', conversationId: 'ferryman-story', lineId: 'ferryman-answer', optionId: 'thank-ferryman' },
      choose('walk-riverbank'), choose('return-from-riverbank'), choose('visit-keeper'),
      choose('leave-keeper'), choose('climb-tower'), choose('enter-chamber'), choose('leave-the-bell'),
    ]);
    expect(snapshot.currentNodeId).toBe('quiet-ending');
    expect(snapshot.state.world['flood-seen']).toBe(true);
  });

  it('resumes the keeper conversation after visiting the archive and returning', () => {
    const returned = play([
      choose('visit-keeper'), choose('speak-to-keeper'), choose('return-from-keeper'),
      choose('search-archive'), choose('read-ledger'), choose('take-record'),
    ]);
    const view = engine.getPlayerView(ashenManifest, ashenWorld, [ashenLocale], returned);
    expect(view.dialogue?.conversationId).toBe('keeper-story');
    expect(view.choices.find(choice => choice.id === 'speak-to-keeper')).toMatchObject({
      enabled: false, disabledReason: 'Finish the current conversation first.',
    });

    const snapshot = play([
      choose('visit-keeper'), choose('speak-to-keeper'), choose('return-from-keeper'),
      choose('search-archive'), choose('read-ledger'), choose('take-record'),
      { kind: 'dialogue-option', conversationId: 'keeper-story', lineId: 'keeper-first', optionId: 'show-ledger' },
      { kind: 'dialogue-option', conversationId: 'keeper-story', lineId: 'keeper-trusts', optionId: 'thank-keeper' },
      choose('leave-keeper'), choose('climb-tower'), choose('enter-chamber'), choose('ring-the-bell'),
    ]);
    expect(snapshot.currentNodeId).toBe('bright-ending');
    expect(snapshot.conversationStack).toEqual([]);
  });

  it('shows Mara granting the key and cannot award it twice', () => {
    const firstReply = play([
      choose('search-archive'), choose('read-ledger'), choose('take-record'), choose('speak-to-keeper'),
      { kind: 'dialogue-option', conversationId: 'keeper-story', lineId: 'keeper-first', optionId: 'show-ledger' },
    ]);
    const firstView = engine.getPlayerView(ashenManifest, ashenWorld, [ashenLocale], firstReply);
    expect(firstView.dialogue?.text).toBe(ashenLocale.strings['keeper-trusts-text']);
    expect(firstView.dialogue?.options.map(option => option.label)).toEqual(['Thank Mara']);
    expect(firstReply.inventory.filter(stack => stack.itemId === 'bell-key')).toHaveLength(1);

    const thanked = advance(firstReply, { kind: 'dialogue-option', conversationId: 'keeper-story', lineId: 'keeper-trusts', optionId: 'thank-keeper' });
    expect(engine.getPlayerView(ashenManifest, ashenWorld, [ashenLocale], thanked).dialogue).toBeUndefined();
    const repeated = advance(advance(advance(thanked, choose('return-from-keeper')), choose('visit-keeper')), choose('speak-to-keeper'));
    const repeatedView = engine.getPlayerView(ashenManifest, ashenWorld, [ashenLocale], repeated);
    expect(repeatedView.dialogue?.options.map(option => option.id)).not.toContain('show-ledger');
    expect(repeatedView.dialogue?.options.map(option => option.id)).toContain('ask-about-key');
    expect(repeated.inventory.filter(stack => stack.itemId === 'bell-key')).toHaveLength(1);

    const reminder = advance(repeated, { kind: 'dialogue-option', conversationId: 'keeper-story', lineId: 'keeper-first', optionId: 'ask-about-key' });
    expect(engine.getPlayerView(ashenManifest, ashenWorld, [ashenLocale], reminder).dialogue?.text).toBe(ashenLocale.strings['keeper-reminder-text']);
    expect(reminder.inventory.filter(stack => stack.itemId === 'bell-key')).toHaveLength(1);
  });

});
