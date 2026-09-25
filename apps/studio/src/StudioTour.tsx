import { useEffect, useRef, useState, type CSSProperties } from 'react';

export type TourPhase = 'invite' | 'tour' | null;
export type TourKind = 'studio' | 'tutorial' | 'sage' | 'apprentice' | 'playtest' | 'play';
type Mode = Exclude<TourKind, 'studio' | 'tutorial'>;
type Step = { mode: Mode; selector: string; eyebrow: string; title: string; body: string };
const STORAGE_KEY = 'dungeon-scrivener-studio-tour-v1';
const steps: Record<TourKind, readonly Step[]> = {
  studio: [
    { mode: 'apprentice', selector: '[data-tour="project-heading"]', eyebrow: 'Your workspace', title: 'One project, two ways to write', body: 'Your title and version stay in view. The same project can be edited visually or in files.' },
    { mode: 'apprentice', selector: '[data-tour="mode-switch"]', eyebrow: 'Choose your desk', title: 'Apprentice or Sage?', body: 'Prefer a visual story map? Choose Apprentice. Comfortable editing project files like a developer? Choose Sage. You can switch at any time.' },
    { mode: 'apprentice', selector: '.apprentice-map', eyebrow: 'Apprentice mode', title: 'See where the story leads', body: 'Scenes and their routes appear here. Select a scene to edit it in the inspector.' },
    { mode: 'sage', selector: '.sage-file-tree', eyebrow: 'Sage mode', title: 'Work in project files', body: 'Explorer opens files in closable tabs. Switch between folders and flat paths, and right-click a file for Rename or Delete.' },
    { mode: 'sage', selector: '[data-tour="playtest-action"]', eyebrow: 'Try it', title: 'Test before you share', body: 'Playtest lets you try actions and inspect state. Play shows the reader experience. Neither changes your authored project.' },
    { mode: 'sage', selector: '[data-tour="project-download"]', eyebrow: 'Keep your work', title: 'Download the editable project', body: 'A project ZIP is your portable authoring copy. Keep it to continue writing later.' },
    { mode: 'sage', selector: '[data-tour="game-export"]', eyebrow: 'Publish', title: 'Make a playable game', body: 'Export creates a separate game ZIP for readers. Extract it, then open index.html.' },
  ],
  apprentice: [
    { mode: 'apprentice', selector: '.apprentice-map', eyebrow: 'Story map', title: 'Follow the scenes', body: 'Each box is a scene or folder. Drag boxes to arrange your map. Teal arrows are player routes; grey dashed lines show folder containment.' },
    { mode: 'apprentice', selector: '[data-tour="graph-toolbar"]', eyebrow: 'Build', title: 'Add and connect', body: 'Add a scene, then drag from its bottom dot to another scene’s top dot to make a player route. You can also select a scene and choose a destination here. A new scene warns as unreachable until you link it from the entry path.' },
    { mode: 'apprentice', selector: '.apprentice-inspector', eyebrow: 'Details', title: 'Write what players see', body: 'Select a scene and edit its title, text, actions, and world settings in the inspector.' },
  ],
  sage: [
    { mode: 'sage', selector: '.sage-file-tree', eyebrow: 'Explorer', title: 'Browse the project', body: 'Choose folder hierarchy or flat paths and sort by name or type. Right-click a row for file actions.' },
    { mode: 'sage', selector: '.sage-editor-area nav[role="tablist"]', eyebrow: 'Open files', title: 'Switch and close tabs', body: 'Open several files from Explorer. Select a tab to return to it, or close it with ×. Your file stays in the project.' },
    { mode: 'sage', selector: '.sage-code-editor', eyebrow: 'Source', title: 'Edit the game data', body: 'world.json holds scenes and actions. project.json holds identity and version. Diagnostics report invalid edits.' },
  ],
  playtest: [
    { mode: 'playtest', selector: '[data-tour="playtest-choices"]', eyebrow: 'Playtest', title: 'Try a player action', body: 'Choose an available action to advance this isolated test session. The scene and game time update above.' },
    { mode: 'playtest', selector: '[data-tour="playtest-checkpoints"]', eyebrow: 'Experiment', title: 'Save a checkpoint', body: 'Create a checkpoint before branching. Restore it to try another choice or restart from the beginning.' },
    { mode: 'playtest', selector: '[data-tour="playtest-inspector"]', eyebrow: 'Inspect', title: 'Read the trace', body: 'Open state and trace panels to see what changed. Debug edits affect only this test session.' },
  ],
  play: [
    { mode: 'play', selector: '.ds-player__scene', eyebrow: 'Reader view', title: 'Read the scene', body: 'This is the exported game experience. Follow the story text and watch the in-game clock.' },
    { mode: 'play', selector: '.ds-player__layout', eyebrow: 'Your move', title: 'Choose an action', body: 'Select a choice or type a command when the game offers one. Inventory and settings are nearby.' },
  ],
  tutorial: [
    { mode: 'apprentice', selector: '.apprentice-map', eyebrow: 'Game tutorial · 1', title: 'Start with a scene', body: 'A game begins at its entry scene. The Old Gate is already your entry point. Give it an opening that poses a question or goal.' },
    { mode: 'apprentice', selector: '[data-tour="graph-toolbar"]', eyebrow: 'Game tutorial · 2', title: 'Add a destination', body: 'Add a scene for what happens next. Drag it into place, then connect the entry scene’s bottom dot to its top dot. The unreachable-scene warning clears once there is a route from the entry. Give each scene a distinct title.' },
    { mode: 'apprentice', selector: '.apprentice-inspector', eyebrow: 'Game tutorial · 3', title: 'Write a meaningful choice', body: 'Select the entry scene. Give its action a clear verb and consequence, then link it to your destination.' },
    { mode: 'apprentice', selector: '[data-tour="playtest-action"]', eyebrow: 'Game tutorial · 4', title: 'Play every branch', body: 'Playtest from the beginning. Take each route, check scene text and game state, then revise confusing or broken paths.' },
    { mode: 'apprentice', selector: '[data-tour="project-download"]', eyebrow: 'Game tutorial · 5', title: 'Keep an editable copy', body: 'Download the project ZIP after authoring. This is the copy you can import later to continue writing.' },
    { mode: 'apprentice', selector: '[data-tour="game-export"]', eyebrow: 'Game tutorial · 6', title: 'Share a playable build', body: 'Export the game ZIP. Extract the whole archive and open index.html to check the reader experience before sharing.' },
  ],
};
const sageTutorial: readonly Step[] = [
  { mode: 'sage', selector: '.sage-file-tree', eyebrow: 'Game tutorial · 1', title: 'Find the game files', body: 'project.json names and versions your game. world.json contains the scenes, actions, and routes. Open world.json to begin.' },
  { mode: 'sage', selector: '.sage-code-editor', eyebrow: 'Game tutorial · 2', title: 'Write an entry scene', body: 'Find entryNodeId near the top, then locate that ID in the nodes array. Each scene has an ID, title, and content. Give the entry a clear opening goal.' },
  { mode: 'sage', selector: '.sage-code-editor', eyebrow: 'Game tutorial · 3', title: 'Add a route and a choice', body: 'Add another visitable node, then a navigationEdge from the entry node to it. A choice action can point to that edge with navigationEdgeId. Keep IDs unique.' },
  { mode: 'sage', selector: '[data-tour="playtest-action"]', eyebrow: 'Game tutorial · 4', title: 'Play every branch', body: 'Playtest from the entry node. Try each choice and inspect errors or state changes. Revise the JSON until every intended path works.' },
  { mode: 'sage', selector: '[data-tour="project-download"]', eyebrow: 'Game tutorial · 5', title: 'Keep the source', body: 'Download the project ZIP after editing. This is the copy you can import later to continue development.' },
  { mode: 'sage', selector: '[data-tour="game-export"]', eyebrow: 'Game tutorial · 6', title: 'Share a playable build', body: 'Export the game ZIP. Extract the archive and open index.html to check the reader experience before sharing.' },
];

export function shouldOfferStudioTour(): boolean { return localStorage.getItem(STORAGE_KEY) === null; }
export function shouldOfferModeTour(kind: Mode): boolean { return localStorage.getItem(`dungeon-scrivener-${kind}-tour-v1`) === null; }

export function StudioTour({ phase, kind, mode, onModeChange, onClose, onStart }: {
  phase: TourPhase; kind: TourKind; mode: Mode | 'home'; onModeChange: (mode: Mode) => void;
  onClose: (outcome: 'skipped' | 'finished', kind: TourKind) => void; onStart: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<{ selector: string; rect: DOMRect } | null>(null);
  const [preferredMode, setPreferredMode] = useState<'apprentice' | 'sage'>('apprentice');
  const inviteRef = useRef<HTMLDialogElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const tourSteps = kind === 'tutorial' && localStorage.getItem('dungeon-scrivener-preferred-mode') === 'sage' ? sageTutorial : steps[kind];
  const step = tourSteps[stepIndex] ?? tourSteps[0]!;

  useEffect(() => {
    if (phase === 'invite' && kind === 'studio' && !inviteRef.current?.open) inviteRef.current?.showModal();
    if ((phase !== 'invite' || kind !== 'studio') && inviteRef.current?.open) inviteRef.current.close();
  }, [phase, kind]);
  useEffect(() => {
    if (phase !== 'tour') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [phase]);
  useEffect(() => { if (phase === 'tour' && mode !== step.mode) onModeChange(step.mode); }, [phase, mode, step.mode, onModeChange]);
  useEffect(() => {
    if (phase !== 'tour' || mode !== step.mode) return;
    const target = document.querySelector<HTMLElement>(step.selector);
    if (!target) { setTargetRect(null); return; }
    setTargetRect(null);
    const update = () => setTargetRect({ selector: step.selector, rect: target.getBoundingClientRect() });
    const timer = window.setTimeout(() => {
      const rect = target.getBoundingClientRect();
      if (rect.top < 84 || rect.bottom > window.innerHeight - 40) window.scrollBy({ top: rect.top - 110, behavior: 'instant' });
      update();
    }, 80);
    const observer = new ResizeObserver(update);
    observer.observe(target);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.clearTimeout(timer); window.removeEventListener('resize', update); };
  }, [phase, mode, step.selector, step.mode]);
  useEffect(() => {
    if (phase !== 'tour') return;
    previousFocus.current = document.activeElement as HTMLElement;
    return () => { (previousFocus.current?.isConnected ? previousFocus.current : document.querySelector<HTMLElement>('.tour-replay'))?.focus(); };
  }, [phase]);
  useEffect(() => { if (phase === 'tour') headingRef.current?.focus({ preventScroll: true }); }, [phase, stepIndex]);

  function close(outcome: 'skipped' | 'finished'): void {
    localStorage.setItem(kind === 'studio' ? STORAGE_KEY : `dungeon-scrivener-${kind}-tour-v1`, outcome);
    setStepIndex(0);
    onClose(outcome, kind);
  }
  const rect = targetRect?.selector === step.selector && targetRect.rect.width > 0 && targetRect.rect.height > 0 ? targetRect.rect : null;
  const ready = mode === step.mode && rect !== null;
  const spotlight: CSSProperties | undefined = rect ? { left: Math.max(6, rect.left - 6), top: Math.max(6, rect.top - 6), width: Math.min(window.innerWidth - 12, rect.width + 12), height: Math.min(window.innerHeight - 12, rect.height + 12) } : undefined;
  const card: CSSProperties = rect && window.innerWidth >= 760 ? (() => {
    const width = 360;
    const rightRoom = window.innerWidth - rect.right;
    if (rightRoom >= width + 28 || rect.left >= width + 28) return { left: rightRoom >= width + 28 ? rect.right + 24 : rect.left - width - 24, top: Math.max(24, Math.min(window.innerHeight - 320, rect.top < 170 ? rect.bottom + 24 : rect.top)) };
    return { left: Math.max(24, Math.min(window.innerWidth - width - 24, rect.left)), top: rect.bottom + 340 < window.innerHeight ? rect.bottom + 24 : Math.max(24, rect.top - 330) };
  })() : {};

  return <>
    <dialog ref={inviteRef} className="tour-invite" aria-labelledby="tour-invite-title" aria-describedby="tour-invite-description" onCancel={event => { event.preventDefault(); close('skipped'); }}>
      <span className="tour-invite__mark" aria-hidden="true">✦</span><p className="eyebrow">A quick orientation</p>
      <h2 id="tour-invite-title">Find your way around the studio</h2>
      <p id="tour-invite-description">See the editing modes, story map, Playtest, and export. You can leave at any point and return later.</p>
      <fieldset className="tour-preference"><legend>Would you prefer a visual, drag-and-drop style map or developer-focused source files?</legend><label><input type="radio" name="tour-mode" checked={preferredMode === 'apprentice'} onChange={() => setPreferredMode('apprentice')} /> Apprentice · visual map</label><label><input type="radio" name="tour-mode" checked={preferredMode === 'sage'} onChange={() => setPreferredMode('sage')} /> Sage · source files</label></fieldset>
      <div className="dialog-actions"><button type="button" onClick={() => close('skipped')}>Not now</button><button type="button" className="button-primary" onClick={() => { localStorage.setItem('dungeon-scrivener-preferred-mode', preferredMode); onStart(); }}>Start tour</button></div>
    </dialog>
    {phase === 'invite' && kind !== 'studio' && (kind === 'tutorial' || kind === mode) && <aside className="tour-nudge" aria-label={`${kind === 'tutorial' ? 'Game tutorial' : `${kind} tour`} invitation`}><span className="eyebrow">{kind === 'tutorial' ? 'Next: make a game' : `Explore ${kind}`}</span><p>{kind === 'tutorial' ? 'Want a six-step introduction to scenes, choices, testing, and sharing?' : `Take a short tour of ${kind} when you are ready.`}</p><div><button type="button" onClick={() => close('skipped')}>Not now</button><button type="button" className="button-primary" onClick={onStart}>{kind === 'tutorial' ? 'Start tutorial' : 'Show me'}</button></div></aside>}
    {phase === 'tour' && <div className="tour-layer" onWheel={event => { if (!cardRef.current?.contains(event.target as Node)) event.preventDefault(); }} onTouchMove={event => { if (!cardRef.current?.contains(event.target as Node)) event.preventDefault(); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close('skipped'); }
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(event.key) && event.target === headingRef.current) event.preventDefault();
      if (event.key === 'Tab') {
        const controls = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="tour-shade" style={rect ? undefined : { background: 'rgb(13 22 18 / 75%)' }} aria-hidden="true" />
      {spotlight && <div className="tour-spotlight" style={spotlight} aria-hidden="true" />}
      <section ref={cardRef} className="tour-card" style={card} role="dialog" aria-modal="true" aria-labelledby="tour-step-title" aria-describedby="tour-step-description">
        <div className="tour-card__top"><span className="eyebrow">{step.eyebrow}</span><button type="button" className="tour-exit" onClick={() => close('skipped')} aria-label="Exit tour">×</button></div>
        <div className="tour-progress" aria-label={`Step ${stepIndex + 1} of ${tourSteps.length}`}>{tourSteps.map((item, index) => <span key={item.title} className={index <= stepIndex ? 'is-current' : ''} />)}</div>
        <h2 id="tour-step-title" ref={headingRef} tabIndex={-1}>{step.title}</h2><p id="tour-step-description">{step.body}</p>
        <div className="tour-card__actions"><span>{String(stepIndex + 1).padStart(2, '0')} / {String(tourSteps.length).padStart(2, '0')}</span><div>{stepIndex > 0 && <button type="button" onClick={() => setStepIndex(index => index - 1)}>Back</button>}<button type="button" className="button-primary" disabled={!ready} onClick={() => stepIndex === tourSteps.length - 1 ? close('finished') : setStepIndex(index => index + 1)}>{stepIndex === tourSteps.length - 1 ? 'Finish tour' : 'Next'}</button></div></div>
      </section>
    </div>}
  </>;
}
