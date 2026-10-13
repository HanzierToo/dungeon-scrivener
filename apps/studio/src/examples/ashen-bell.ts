import type { ChoiceDefinition, LocaleDocument, NodeDefinition, ProjectManifest, WorldDocument } from '@dungeon-scrivener/model';
import { emptyGraphLayout, type GraphLayout } from '@dungeon-scrivener/apprentice';

const text = (key: string) => ({ kind: 'locale-key' as const, key });
const worldScope = { kind: 'world' as const };
const state = (key: string) => ({ scope: worldScope, key });
const choice = (id: string, edge: string, effects: ChoiceDefinition['effects'] = [], condition?: ChoiceDefinition['condition']): ChoiceDefinition => ({
  id, label: text(`choice-${id}`), navigationEdgeId: edge, effects, ...(condition ? { condition } : {}),
});
const scene = (id: string, choices: readonly ChoiceDefinition[] = [], extra: Partial<NodeDefinition> = {}): NodeDefinition => ({
  id, parentId: null, visitable: true, title: text(`${id}-title`), content: text(`${id}-content`),
  ...(choices.length ? { actions: { choices: [...choices] } } : {}), ...extra,
});
const edge = (fromNodeId: string, toNodeId: string) => ({ id: `${fromNodeId}-to-${toNodeId}`, fromNodeId, toNodeId });

export const ashenManifest: ProjectManifest = {
  format: 'dungeon-scrivener-project', schemaVersion: 1, projectId: 'the-ashen-bell', title: 'The Ashen Bell', defaultLocale: 'en-GB', gameVersion: '1.0.0',
};

export const ashenWorld: WorldDocument = {
  format: 'dungeon-scrivener-world', schemaVersion: 1, entryNodeId: 'village-square',
  settings: { time: { mode: 'per-action', millisecondsPerAction: 1000, hiddenBehavior: 'pause', maxCatchUpMilliseconds: 0, showClockHud: false }, randomness: { mode: 'seeded' } },
  savePolicy: { enabled: false, slotCount: 0, allowedLocation: 'anywhere' },
  stateDefinitions: [
    { key: 'clue-found', scopeKind: 'world', valueType: 'boolean', defaultValue: false },
    { key: 'keeper-trust', scopeKind: 'world', valueType: 'integer', defaultValue: 0 },
    { key: 'flood-seen', scopeKind: 'world', valueType: 'boolean', defaultValue: false },
    { key: 'bell-rung', scopeKind: 'world', valueType: 'boolean', defaultValue: false },
  ],
  worldState: { 'clue-found': false, 'keeper-trust': 0, 'flood-seen': false, 'bell-rung': false },
  nodes: [
    scene('village-square', [
      choice('search-archive', 'village-square-to-archive'),
      choice('visit-ferryman', 'village-square-to-ferry-landing'),
      choice('visit-keeper', 'village-square-to-keeper-house'),
    ]),
    scene('archive', [
      choice('read-ledger', 'archive-to-archive-annex', [{ kind: 'set-state', target: state('clue-found'), value: true }]),
      choice('leave-archive', 'archive-to-village-square'),
    ]),
    scene('archive-annex', [choice('take-record', 'archive-annex-to-keeper-house')]),
    scene('ferry-landing', [choice('walk-riverbank', 'ferry-landing-to-riverbank'), choice('return-from-ferry', 'ferry-landing-to-village-square')], {
      actions: { choices: [choice('walk-riverbank', 'ferry-landing-to-riverbank'), choice('return-from-ferry', 'ferry-landing-to-village-square')],
        commands: [{ id: 'ask-ferryman', patterns: ['talk to ferryman', 'speak to ferryman'], parameters: [], effects: [{ kind: 'start-conversation', conversationId: 'ferryman-story' }] }] },
    }),
    scene('riverbank', [choice('return-from-riverbank', 'riverbank-to-village-square')], { ruleIds: ['mark-flood'] }),
    scene('keeper-house', [choice('leave-keeper', 'keeper-house-to-flooded-lane'), choice('return-from-keeper', 'keeper-house-to-village-square')], {
      actions: { choices: [
        { id: 'speak-to-keeper', label: text('choice-speak-to-keeper'), effects: [{ kind: 'start-conversation', conversationId: 'keeper-story' }] },
        choice('leave-keeper', 'keeper-house-to-flooded-lane'), choice('return-from-keeper', 'keeper-house-to-village-square'),
      ] },
    }),
    scene('flooded-lane', [choice('climb-tower', 'flooded-lane-to-bell-tower'), choice('turn-back', 'flooded-lane-to-keeper-house')]),
    scene('bell-tower', [choice('enter-chamber', 'bell-tower-to-bell-chamber')]),
    scene('bell-chamber', [
      choice('ring-the-bell', 'bell-chamber-to-bright-ending', [{ kind: 'set-state', target: state('bell-rung'), value: true }], { kind: 'has-item', owner: worldScope, itemId: 'bell-key', quantity: 1 }),
      choice('leave-the-bell', 'bell-chamber-to-quiet-ending'),
      choice('return-for-key', 'bell-chamber-to-keeper-house'),
    ]),
    scene('bright-ending'),
    scene('quiet-ending'),
  ],
  navigationEdges: [
    edge('village-square', 'archive'), edge('village-square', 'ferry-landing'), edge('village-square', 'keeper-house'),
    edge('archive', 'archive-annex'), edge('archive', 'village-square'), edge('archive-annex', 'keeper-house'),
    edge('ferry-landing', 'riverbank'), edge('ferry-landing', 'village-square'), edge('riverbank', 'village-square'),
    edge('keeper-house', 'flooded-lane'), edge('keeper-house', 'village-square'), edge('flooded-lane', 'bell-tower'),
    edge('flooded-lane', 'keeper-house'), edge('bell-tower', 'bell-chamber'), edge('bell-chamber', 'bright-ending'),
    edge('bell-chamber', 'quiet-ending'), edge('bell-chamber', 'keeper-house'),
  ],
  entityDefinitions: [{ id: 'villager', name: text('villager-type'), fields: [], allowedTags: [] }],
  entities: [
    { id: 'keeper', definitionId: 'villager', name: text('keeper-name'), tags: [], state: {} },
    { id: 'ferryman', definitionId: 'villager', name: text('ferryman-name'), tags: [], state: {} },
  ],
  actionDefaults: { choices: [], commands: [] }, eventDefinitions: [],
  rules: [{ id: 'mark-flood', trigger: { kind: 'phase', phase: 'node-entry' }, priority: 10, condition: { kind: 'at-node', nodeId: 'riverbank' },
    effects: [{ kind: 'set-state', target: state('flood-seen'), value: true }] }],
  conversations: [
    { id: 'keeper-story', participantEntityIds: ['keeper'], entryLineId: 'keeper-first', interruptible: false, resumeOnReturn: true, lines: [
      { id: 'keeper-first', speakerEntityId: 'keeper', text: text('keeper-first-text'), options: [
        { id: 'show-ledger', text: text('show-ledger-text'), condition: { kind: 'all', conditions: [
          { kind: 'compare-state', left: state('clue-found'), operator: 'eq', right: true },
          { kind: 'compare-state', left: state('keeper-trust'), operator: 'eq', right: 0 },
        ] }, nextLineId: 'keeper-trusts', effects: [{ kind: 'set-state', target: state('keeper-trust'), value: 1 }, { kind: 'add-item', owner: worldScope, itemId: 'bell-key', quantity: 1 }] },
        { id: 'ask-about-key', text: text('ask-about-key-text'), condition: { kind: 'compare-state', left: state('keeper-trust'), operator: 'eq', right: 1 }, nextLineId: 'keeper-reminder', effects: [] },
        { id: 'leave-keeper-talk', text: text('leave-keeper-talk-text'), nextLineId: 'keeper-goodbye', effects: [] },
      ] },
      { id: 'keeper-trusts', speakerEntityId: 'keeper', text: text('keeper-trusts-text'), options: [{ id: 'thank-keeper', text: text('thank-keeper-text'), effects: [] }] },
      { id: 'keeper-reminder', speakerEntityId: 'keeper', text: text('keeper-reminder-text'), options: [{ id: 'leave-after-reminder', text: text('leave-after-reminder-text'), effects: [] }] },
      { id: 'keeper-goodbye', speakerEntityId: 'keeper', text: text('keeper-goodbye-text'), options: [{ id: 'leave-after-goodbye', text: text('leave-after-goodbye-text'), effects: [] }] },
    ] },
    { id: 'ferryman-story', participantEntityIds: ['ferryman'], entryLineId: 'ferryman-first', interruptible: false, resumeOnReturn: true, lines: [
      { id: 'ferryman-first', speakerEntityId: 'ferryman', text: text('ferryman-first-text'), options: [
        { id: 'ask-bell', text: text('ask-bell-text'), nextLineId: 'ferryman-answer', effects: [] },
      ] },
      { id: 'ferryman-answer', speakerEntityId: 'ferryman', text: text('ferryman-answer-text'), options: [{ id: 'thank-ferryman', text: text('thank-ferryman-text'), effects: [] }] },
    ] },
  ],
  itemDefinitions: [{ id: 'bell-key', name: text('bell-key-name'), stackLimit: 1, canContain: false, fields: [] }],
  initialInventory: [], scripts: [],
};

export const ashenLocale: LocaleDocument = { format: 'dungeon-scrivener-locale', schemaVersion: 1, locale: 'en-GB', strings: {
  'village-square-title': 'The Square at Dusk', 'village-square-content': 'Rain has swallowed the road to the old bell tower. At dawn, the river will take the lower houses. The bell could summon everyone uphill, if anyone can make it ring.',
  'archive-title': 'The Rain-dark Archive', 'archive-content': 'The village records smell of wet paper. A ledger lies open beneath a cracked window. Someone marked the bell keeper’s name in red ink.',
  'archive-annex-title': 'The Missing Page', 'archive-annex-content': 'The final page explains why the bell fell silent. Its iron tongue was sealed away after the last flood. The keeper has the key, and proof of the old warning may persuade her.',
  'ferry-landing-title': 'The Empty Ferry', 'ferry-landing-content': 'The ferryman has tied his boat above the rising water. Type “talk to ferryman” if you want to hear what he knows.',
  'riverbank-title': 'The Riverbank', 'riverbank-content': 'A fence disappears under the current as you watch. The water is no longer a distant threat. You have seen how little time remains.',
  'keeper-house-title': 'The Keeper’s House', 'keeper-house-content': 'A lamp burns behind the shutters. The keeper will speak, but she has heard too many strangers promise help. The archive may give you something better than a promise.',
  'flooded-lane-title': 'The Flooded Lane', 'flooded-lane-content': 'Water pushes through the cobbles. Above it, the tower door stands open. You can still turn back to the keeper.',
  'bell-tower-title': 'The Bell Tower', 'bell-tower-content': 'The stairs are worn smooth. Every step sounds louder than the rain. The bell waits one floor above.',
  'bell-chamber-title': 'The Silent Bell', 'bell-chamber-content': 'The great bell hangs over the village. With the keeper’s key, you can release its tongue and call everyone to safety. Without it, you must decide when to leave.',
  'bright-ending-title': 'The Bell Answers', 'bright-ending-content': 'One strike rolls across the roofs, then another. Doors open. Lanterns climb toward the high road as the river enters the square. The village has time to move.',
  'quiet-ending-title': 'A Quiet Warning', 'quiet-ending-content': 'You cannot wake the bell, but you can still wake the houses nearest the river. By dawn, some have reached the high road. The silence tells you where to begin again.',
  'choice-search-archive': 'Search the village archive', 'choice-visit-ferryman': 'Look for the ferryman', 'choice-visit-keeper': 'Visit the bell keeper',
  'choice-read-ledger': 'Read the marked ledger', 'choice-leave-archive': 'Return to the square', 'choice-take-record': 'Take the page to the keeper',
  'choice-walk-riverbank': 'Walk along the river', 'choice-return-from-ferry': 'Return to the square', 'choice-return-from-riverbank': 'Hurry back to the square',
  'choice-speak-to-keeper': 'Speak to the keeper', 'choice-leave-keeper': 'Head for the tower', 'choice-return-from-keeper': 'Return to the square',
  'choice-climb-tower': 'Climb the tower', 'choice-turn-back': 'Turn back to the keeper', 'choice-enter-chamber': 'Enter the bell chamber',
  'choice-ring-the-bell': 'Unlock and ring the bell', 'choice-leave-the-bell': 'Leave the silent bell and warn who you can', 'choice-return-for-key': 'Return to the keeper',
  'villager-type': 'Villager', 'keeper-name': 'Mara, the bell keeper', 'ferryman-name': 'Ivo, the ferryman', 'bell-key-name': 'Bell key',
  'keeper-first-text': '“I locked the bell after the last flood. I will not send people into the dark for a rumor. Bring me proof from the archive.”', 'show-ledger-text': 'Show her the warning in the ledger',
  'ask-about-key-text': 'Ask about the bell key', 'leave-keeper-talk-text': 'Leave her to her lamp',
  'keeper-trusts-text': 'Mara reads the page twice. “Then I was wrong to wait.” She puts the cold iron key in your hand.', 'thank-keeper-text': 'Thank Mara',
  'keeper-reminder-text': '“I have already given you the key. Take it to the tower before the river reaches the square.”', 'leave-after-reminder-text': 'Head back outside',
  'keeper-goodbye-text': 'Mara closes the door softly, leaving the lamplight on.', 'leave-after-goodbye-text': 'Head back outside',
  'ferryman-first-text': '“The current took my lower mooring an hour ago,” Ivo says. “No one below the square has heard a warning.”',
  'ask-bell-text': 'Ask why the bell is silent', 'ferryman-answer-text': '“Mara keeps its key. Bring her proof from the archive, or she will think you are chasing a ghost.”', 'thank-ferryman-text': 'Thank Ivo',
} };

// Keep the main route centered. The two evidence branches sit on either side,
// with visual sections that can be collapsed without changing story logic.
export const ashenLayout: GraphLayout = {
  ...emptyGraphLayout(),
  positions: {
    'village-square': { x: 600, y: 0 },
    archive: { x: 180, y: 140 },
    'archive-annex': { x: 180, y: 280 },
    'ferry-landing': { x: 1020, y: 140 },
    riverbank: { x: 1020, y: 280 },
    'keeper-house': { x: 600, y: 420 },
    'flooded-lane': { x: 600, y: 560 },
    'bell-tower': { x: 600, y: 700 },
    'bell-chamber': { x: 600, y: 840 },
    'bright-ending': { x: 340, y: 980 },
    'quiet-ending': { x: 860, y: 980 },
  },
  sections: [
    { id: 'archive-search', title: 'The search', x: 130, y: 95, width: 320, height: 285, collapsed: false, nodeIds: ['archive', 'archive-annex'] },
    { id: 'river-crossing', title: 'The crossing', x: 970, y: 95, width: 320, height: 285, collapsed: false, nodeIds: ['ferry-landing', 'riverbank'] },
    { id: 'bell-finale', title: 'The bell', x: 285, y: 655, width: 825, height: 435, collapsed: false, nodeIds: ['bell-tower', 'bell-chamber', 'bright-ending', 'quiet-ending'] },
  ],
};
