import { useEffect, useRef, useState, type CSSProperties } from 'react';

export type TourPhase = 'invite' | 'tour' | null;
type TourMode = 'sage' | 'apprentice';

const STORAGE_KEY = 'dungeon-scrivener-studio-tour-v1';
const steps: readonly { mode: TourMode; selector: string; eyebrow: string; title: string; body: string }[] = [
  { mode: 'apprentice', selector: '[data-tour="project-heading"]', eyebrow: 'Your workspace', title: 'One project, two ways to write', body: 'The project title and version stay in view. Apprentice lets you shape scenes on a map; Sage edits the project files directly. Both work on the same story.' },
  { mode: 'sage', selector: '.sage-file-tree', eyebrow: 'Sage mode', title: 'Start with the story files', body: 'Open world.json for scenes and choices, or project.json for the game title and version. Changes are kept in local recovery while you work.' },
  { mode: 'apprentice', selector: '.apprentice-map', eyebrow: 'Apprentice mode', title: 'See where the story leads', body: 'Scenes live on this map. Select one to edit its text and actions in the inspector. Connect scenes to give players a route through your story.' },
  { mode: 'apprentice', selector: '[data-tour="playtest-action"]', eyebrow: 'Try it', title: 'Test before you share', body: 'Playtest opens an isolated session with state and trace tools. Play shows the reader experience. Neither action changes your authored files.' },
  { mode: 'apprentice', selector: '[data-tour="project-download"]', eyebrow: 'Keep your work', title: 'Download the editable project', body: 'A project ZIP is your portable authoring copy. Local recovery helps after an interruption, but a downloaded ZIP is the copy you can move or archive.' },
  { mode: 'apprentice', selector: '[data-tour="game-export"]', eyebrow: 'Publish', title: 'Make a playable game', body: 'Export creates a separate game ZIP for readers. Extract it, then open index.html. You can revisit this tour from the workspace whenever you like.' },
];

export function shouldOfferStudioTour(): boolean {
  return localStorage.getItem(STORAGE_KEY) === null;
}

export function StudioTour({ phase, mode, onModeChange, onClose, onStart }: {
  phase: TourPhase;
  mode: TourMode | 'play' | 'playtest' | 'home';
  onModeChange: (mode: TourMode) => void;
  onClose: (outcome: 'skipped' | 'finished') => void;
  onStart: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<{ selector: string; rect: DOMRect } | null>(null);
  const inviteRef = useRef<HTMLDialogElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const step = steps[stepIndex]!;

  useEffect(() => {
    if (phase === 'invite' && !inviteRef.current?.open) inviteRef.current?.showModal();
    if (phase !== 'invite' && inviteRef.current?.open) inviteRef.current.close();
  }, [phase]);

  useEffect(() => {
    if (phase !== 'tour') return;
    if (mode !== step.mode) onModeChange(step.mode);
  }, [phase, mode, step.mode, onModeChange]);

  useEffect(() => {
    if (phase !== 'tour' || mode !== step.mode) return;
    const target = document.querySelector<HTMLElement>(step.selector);
    if (!target) { setTargetRect(null); return; }
    setTargetRect(null);
    const update = () => setTargetRect({ selector: step.selector, rect: target.getBoundingClientRect() });
    const scrollTimer = window.setTimeout(() => {
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      update();
    }, 60);
    const observer = new ResizeObserver(update);
    observer.observe(target);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer.disconnect();
      window.clearTimeout(scrollTimer);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [phase, mode, step.selector, step.mode]);

  useEffect(() => {
    if (phase !== 'tour') return;
    previousFocus.current = document.activeElement as HTMLElement;
    return () => {
      const fallback = document.querySelector<HTMLElement>('.tour-replay');
      (previousFocus.current?.isConnected && previousFocus.current.closest('dialog')?.open !== false
        ? previousFocus.current : fallback)?.focus();
      previousFocus.current = null;
    };
  }, [phase]);

  useEffect(() => {
    if (phase === 'tour') headingRef.current?.focus({ preventScroll: true });
  }, [phase, stepIndex]);

  function close(outcome: 'skipped' | 'finished'): void {
    localStorage.setItem(STORAGE_KEY, outcome);
    setStepIndex(0);
    onClose(outcome);
    if (phase === 'invite') window.setTimeout(() => window.scrollTo(0, 0), 60);
  }

  const safeRect = targetRect?.selector === step.selector && targetRect.rect.width > 0 && targetRect.rect.height > 0 ? targetRect.rect : null;
  const stepReady = mode === step.mode && safeRect !== null;
  const spotlight: CSSProperties | undefined = safeRect ? {
    left: Math.max(6, safeRect.left - 6),
    top: Math.max(6, safeRect.top - 6),
    width: Math.min(window.innerWidth - 12, safeRect.width + 12),
    height: Math.min(window.innerHeight - 12, safeRect.height + 12),
  } : undefined;
  const card: CSSProperties = safeRect && window.innerWidth >= 760
    ? { top: Math.max(24, Math.min(window.innerHeight - 340, Math.max(24, safeRect.top))),
        left: safeRect.right + 380 < window.innerWidth ? safeRect.right + 22 : Math.max(24, safeRect.left - 370) }
    : {};

  return <>
    <dialog ref={inviteRef} className="tour-invite" aria-labelledby="tour-invite-title" aria-describedby="tour-invite-description"
      onCancel={event => { event.preventDefault(); close('skipped'); }}>
      <span className="tour-invite__mark" aria-hidden="true">✦</span>
      <p className="eyebrow">A quick orientation</p>
      <h2 id="tour-invite-title">Find your way around the studio</h2>
      <p id="tour-invite-description">Take a short guided look at the editor, story map, playtest, and the two downloads. You can leave at any point or start it again later.</p>
      <div className="dialog-actions">
        <button type="button" onClick={() => close('skipped')}>Not now</button>
        <button type="button" className="button-primary" onClick={() => { setStepIndex(0); onStart(); }}>Start tour</button>
      </div>
    </dialog>
    {phase === 'tour' && <div className="tour-layer" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close('skipped'); }
      if (event.key === 'Tab') {
        const controls = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="tour-shade" style={safeRect ? undefined : { background: 'rgb(13 22 18 / 75%)' }} aria-hidden="true" />
      {spotlight && <div className="tour-spotlight" style={spotlight} aria-hidden="true" />}
      <section ref={cardRef} className="tour-card" style={card} role="dialog" aria-modal="true" aria-labelledby="tour-step-title" aria-describedby="tour-step-description">
        <div className="tour-card__top"><span className="eyebrow">{step.eyebrow}</span><button type="button" className="tour-exit" onClick={() => close('skipped')} aria-label="Exit tour">×</button></div>
        <div className="tour-progress" aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
          {steps.map((item, index) => <span key={item.title} className={index <= stepIndex ? 'is-current' : ''} />)}
        </div>
        <h2 id="tour-step-title" ref={headingRef} tabIndex={-1}>{step.title}</h2>
        <p id="tour-step-description">{step.body}</p>
        <div className="tour-card__actions">
          <span>{String(stepIndex + 1).padStart(2, '0')} / {String(steps.length).padStart(2, '0')}</span>
          <div>
            {stepIndex > 0 && <button type="button" onClick={() => setStepIndex(index => index - 1)}>Back</button>}
            <button type="button" className="button-primary" disabled={!stepReady} onClick={() => stepIndex === steps.length - 1 ? close('finished') : setStepIndex(index => index + 1)}>{stepIndex === steps.length - 1 ? 'Finish tour' : 'Next'}</button>
          </div>
        </div>
      </section>
    </div>}
  </>;
}
