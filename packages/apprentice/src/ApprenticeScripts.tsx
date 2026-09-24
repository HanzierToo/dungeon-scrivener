import type { ProjectVfsSnapshot, WorldDocument } from '@dungeon-scrivener/model';

export interface ApprenticeScriptsProps {
  readonly world: WorldDocument;
  readonly project: ProjectVfsSnapshot;
  /** Studio supplies the mode switch and opens this path in the Sage workspace. */
  readonly onEditInSage: (path: string) => void;
}

const languageName = (language: WorldDocument['scripts'][number]['language']): string => {
  switch (language) {
    case 'javascript': return 'JavaScript';
    case 'lua': return 'Lua';
    case 'python': return 'Python';
  }
};

/** Shows script declarations as opaque metadata. It never decodes or writes script bytes. */
export function ApprenticeScripts({ world, project, onEditInSage }: ApprenticeScriptsProps) {
  return <section aria-label="Advanced scripts">
    <h2>Advanced scripts</h2>
    {world.scripts.length === 0
      ? <p>This project has no advanced scripts.</p>
      : world.scripts.map((script) => {
        const sourceExists = project.files.has(script.path);
        return <article key={script.id} aria-label={`Script ${script.id}`} style={{ border: '1px solid #bbb', borderRadius: 4, margin: '8px 0', padding: 12 }}>
          <h3>{script.id}</h3>
          <dl>
            <dt>Language</dt><dd>{languageName(script.language)}</dd>
            <dt>File</dt><dd><code>{script.path}</code></dd>
            <dt>Entry point</dt><dd><code>{script.entrypoint}</code></dd>
          </dl>
          {!sourceExists && <p role="status">The declared source file is missing from this project snapshot.</p>}
          <button type="button" disabled={!sourceExists} onClick={() => onEditInSage(script.path)}>Edit in Sage</button>
        </article>;
      })}
    <p>Script source is kept as authored in its project file. Apprentice displays declarations only.</p>
  </section>;
}
