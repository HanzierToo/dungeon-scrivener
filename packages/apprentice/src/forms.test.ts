import { describe, expect, it } from 'vitest';
import { createSession, dispatchPlayerInput } from '../../engine/src/core/index.js';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { validateWorldDocument, type ProjectFile, type ProjectVfsSnapshot, type WorldDocument } from '@dungeon-scrivener/model';
import linearWorld from '../../../fixtures/linear-three-nodes/world.json';
import tavernWorldJson from '../../../fixtures/tavern-at-dusk/world.json';
import { ApprenticeScripts } from './ApprenticeScripts.js';
import { updateNodeDefinition } from './commands.js';

function formOutputWorld(): WorldDocument {
  const world = structuredClone(linearWorld) as WorldDocument;
  return {
    ...world,
    stateDefinitions: [...world.stateDefinitions, { key: 'trust', scopeKind: 'world', valueType: 'integer', defaultValue: 0 }],
    worldState: { ...world.worldState, trust: 0 },
    entityDefinitions: [{ id: 'speaker-kind', name: { kind: 'literal', text: 'Speaker' }, fields: [], allowedTags: [] }],
    entities: [{ id: 'guide', definitionId: 'speaker-kind', name: { kind: 'literal', text: 'Guide' }, tags: [], state: {} }],
    eventDefinitions: [...world.eventDefinitions, { id: 'answer-given', payloadFields: [] }],
    nodes: world.nodes.map((node) => node.id === world.entryNodeId ? {
      ...node,
      ruleIds: ['reward-answer'],
      actions: { ...node.actions, choices: [{ id: 'begin-talk', label: { kind: 'literal', text: 'Talk' }, effects: [{ kind: 'start-conversation', conversationId: 'greeting' }] }] },
    } : node),
    conversations: [{
      id: 'greeting', participantEntityIds: ['guide'], entryLineId: 'question', interruptible: true, resumeOnReturn: true,
      lines: [{
        id: 'question', speakerEntityId: 'guide', text: { kind: 'literal', text: 'Do you trust me?' },
        options: [{
          id: 'say-yes', text: { kind: 'literal', text: 'Yes' },
          condition: { kind: 'compare-state', left: { scope: { kind: 'world' }, key: 'trust' }, operator: 'eq', right: 0 },
          effects: [{ kind: 'emit-event', eventId: 'answer-given', payload: {} }],
        }],
      }],
    }],
    rules: [{
      id: 'reward-answer', trigger: { kind: 'event', eventId: 'answer-given' }, priority: 20,
      condition: { kind: 'at-node', nodeId: world.entryNodeId },
      effects: [{ kind: 'increment-state', target: { scope: { kind: 'world' }, key: 'trust' }, amount: 1 }],
    }],
  };
}

describe('Apprentice shared-model forms', () => {
  it('validates a conditional dialogue and priority rule, then runs both through the shared engine', () => {
    const authoredWorld = formOutputWorld();
    const validation = validateWorldDocument(authoredWorld);
    expect(validation.ok).toBe(true);
    if (!validation.ok || !validation.value) return;

    const session = createSession(
      { seededSeedSource: { nextUint32: () => 7 } },
      { format: 'dungeon-scrivener-compiled-script-bundle', schemaVersion: 1, scripts: [] },
      'apprentice-preview', validation.value,
      { randomSeed: 1, wallClockEpochMilliseconds: 1_000, visibility: 'visible', focused: true },
    );
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const started = dispatchPlayerInput(validation.value, session.snapshot, { kind: 'choice', actionId: 'begin-talk' });
    expect(started.snapshot.activeConversation?.lineId).toBe('question');
    const answered = dispatchPlayerInput(validation.value, started.snapshot, {
      kind: 'dialogue-option', conversationId: 'greeting', lineId: 'question', optionId: 'say-yes',
    });
    expect(answered.resolution.kind).toBe('dialogue-option');
    expect(answered.snapshot.state.world['trust']).toBe(1);
    expect(answered.trace.some((record) => record.kind === 'rule' && record.source.kind === 'rule' && record.source.ruleId === 'reward-answer')).toBe(true);
  });

  it('shows opaque script declarations and preserves source bytes and untouched node fields during a neighboring edit', () => {
    const world = structuredClone(tavernWorldJson) as WorldDocument;
    const sourceFiles = world.scripts.map((script) => ({
      path: script.path,
      bytes: new Uint8Array(readFileSync(new URL(`../../../fixtures/tavern-at-dusk/${script.path}`, import.meta.url))),
      role: 'script' as const,
    } satisfies ProjectFile));
    const snapshot: ProjectVfsSnapshot = {
      format: 'dungeon-scrivener-project-vfs-index', schemaVersion: 1, projectId: 'tavern-at-dusk',
      directories: new Set(['scripts']), files: new Map(sourceFiles.map((file) => [file.path, file])),
    };
    const sourceBytesBefore = new Map(sourceFiles.map((file) => [file.path, file.bytes.slice()]));
    const untouchedNode = structuredClone(world.nodes.find((node) => node.id === 'taproom')) as (typeof world.nodes[number] & { futureNodeField?: unknown });
    untouchedNode.futureNodeField = { keep: ['as-authored'] };
    const untouchedNodeBefore = structuredClone(untouchedNode);
    const originalEditableNode = structuredClone(world.nodes.find((node) => node.id === 'tavern-hall')) as (typeof world.nodes[number] & { futureNodeField?: unknown });
    const editableNode = { ...originalEditableNode, futureNodeField: { alsoKeep: true } };
    const firstChoice = editableNode.actions?.choices?.[0];
    expect(firstChoice).toBeDefined();
    if (!firstChoice) return;
    const extendedChoice = { ...firstChoice, futureChoiceField: 'preserve-me', label: { kind: 'literal' as const, text: 'A nearby edited choice' } };
    const editedNode = { ...editableNode, actions: { ...editableNode.actions, choices: [extendedChoice, ...(editableNode.actions?.choices?.slice(1) ?? [])] } };
    const prepared = { ...world, nodes: world.nodes.map((node) => node.id === 'taproom' ? untouchedNode : node.id === 'tavern-hall' ? editedNode : node) } as WorldDocument;
    const edited = updateNodeDefinition(prepared, editedNode.id, (node) => node);
    expect(edited).toBeDefined();
    expect(edited?.nodes.find((node) => node.id === 'taproom')).toEqual(untouchedNodeBefore);
    expect((edited?.nodes.find((node) => node.id === 'tavern-hall')?.actions?.choices?.[0] as typeof extendedChoice).futureChoiceField).toBe('preserve-me');

    const sageTargets: string[] = [];
    const html = renderToStaticMarkup(createElement(ApprenticeScripts, { world: edited ?? prepared, project: snapshot, onEditInSage: (path) => sageTargets.push(path) }));
    expect(html).toContain('Advanced scripts');
    expect(html).toContain('keeper-check');
    expect(html).toContain('JavaScript');
    expect(html).toContain('main');
    expect(html.match(/Edit in Sage/g)).toHaveLength(3);
    expect(sageTargets).toEqual([]);
    expect((edited ?? prepared).scripts).toEqual(world.scripts);
    for (const [path, bytes] of sourceBytesBefore) expect(snapshot.files.get(path)?.bytes).toEqual(bytes);
  });
});
