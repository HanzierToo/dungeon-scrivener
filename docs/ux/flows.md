# DungeonScrivener 1.0: Authoring UX flows

Task 2 deliverable. These are desktop-first, low-fidelity flows for the same project in Apprentice and Sage modes. They describe visible author behavior; they do not define schemas, package APIs, or production UI.

## Shared navigation and interaction rules

- Keep the project title, current mode, diagnostics, recovery status, and the **Playtest**, **Download project ZIP**, and **Export game ZIP** actions reachable from either mode.
- Apprentice and Sage edit one project. A mode switch changes the editing view only. It must preserve the project’s files and any Sage-only script source exactly; it does not convert or reserialize that source.
- Distinguish scene containment (the outline/tree) from navigation (the links that represent where play can go). Do not imply that moving a scene in the outline changes its navigation.
- Provide form controls for graph operations. Dragging may be an additional shortcut, but it is never the only way to create or connect scenes.
- Keep recovery automatic and non-modal. A deliberate project ZIP download, playtest, or game export may show diagnostics that require acknowledgment. A validation problem must not silently discard a file or hide an error.

## Screen 1: Projects, create, and import

```text
┌ DungeonScrivener ───────────────────────────────────────────────────────┐
│ Projects                                      [New project] [Import ZIP]│
├─────────────────────────────────────────────────────────────────────────┤
│ Recent projects                                                         │
│                                                                         │
│  [Project title]   Modified [date]   [Open]                             │
│  [Project title]   Modified [date]   [Open]                             │
│                                                                         │
│  No recent projects? Create a project or import a project ZIP.          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Create flow.** `New project` opens a small form with project title and default language, plus **Create project** and **Cancel**. Creating opens the new project in Apprentice Mode. The empty graph explains that a scene is a story location and offers **Add first scene**. The first scene form includes title and story text, and marks that scene as the entry scene by default while no entry exists. The author can then add a second scene and connect it with a choice.

**Import flow.** `Import ZIP` opens a native file chooser restricted to project ZIP selection. After selection, show the archive name, size, and **Import project** / **Cancel**. On import, keep the screen in a labeled loading state. When accepted, open the project in Apprentice Mode and show a non-blocking diagnostics summary if authored content has issues. Keep invalid authored files available for recovery and project ZIP download. If the archive itself cannot be safely read, keep the current project untouched and show the reason with **Choose another ZIP**.

```text
┌ Import project ZIP ─────────────────────────────────────────────────────┐
│ File: lantern-story.zip                                  [Choose file]  │
│                                                                         │
│ Import copies the project into local recovery. It does not run scripts. │
│                                                                         │
│                                      [Cancel] [Import project]          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Screen 2: Apprentice Mode, graph and forms

```text
┌ Lantern Story · Apprentice ─────────────────────────────────────────────┐
│ [Apprentice ▾]  [Playtest] [Download project ZIP] [Export game ZIP]    │
├─────────────────┬──────────────────────────┬──────────────────────────┤
│ Scene outline   │ Navigation map            │ Scene inspector          │
│                 │                           │                          │
│ ▾ Scenes        │  [Entry: Market] ───────► │ Title                    │
│   Market        │         │                 │ [Market                 ]│
│   Alley         │         ▼                 │                          │
│                 │       [Alley]             │ Story text               │
│ [+ Add scene]   │                           │ [                       ]│
│                 │ [+ Add connection]        │ Choices and commands    │
│                 │                           │ State and rules          │
│                 │                           │ Scripts                  │
├─────────────────┴──────────────────────────┴──────────────────────────┤
│ Recovery: up to date · Diagnostics: 1 warning [Review]                 │
└─────────────────────────────────────────────────────────────────────────┘
```

The scene outline shows containment. The map shows navigation connections, with the entry scene clearly marked. Selecting a scene opens its form in the inspector. Use separate, named controls for **Add child scene** and **Add navigation connection**. When there are no scenes, replace the map with an explanation and **Add first scene**. When a scene has no outgoing navigation, say so and offer **Add connection**. When no scene is selected, the inspector explains how to select one.

Forms group author concepts under plain-language headings such as **Story text**, **Choices and commands**, **State and rules**, and **Scripts**. Show validation beside the relevant field and in Diagnostics. Selecting a diagnostic moves focus to its field, scene, or file. Preserve user-entered text if a field has an error.

## Screen 3: Sage Mode, file editing

```text
┌ Lantern Story · Sage ───────────────────────────────────────────────────┐
│ [Sage ▾] [Playtest] [Download project ZIP] [Export game ZIP]            │
├─────────────────────┬────────────────────────────────┬─────────────────┤
│ Project files       │ Editor tabs                    │ Diagnostics     │
│                     │                                │                 │
│ ▾ project           │ world.json   scripts/guard.lua │ 1 warning       │
│   project.json      │                                │ [Open location] │
│   world.json        │  1  { ... }                    │                 │
│ ▾ locales           │  2  ...                        │                 │
│ ▾ scripts           │  3  ...                        │                 │
│   guard.lua         │                                │                 │
│ ▾ assets            │                                │                 │
│   lantern.png       │                                │                 │
│   [+ Add file]      │                                │                 │
├─────────────────────┴────────────────────────────────┴─────────────────┤
│ Recovery: up to date · Modified tab marked with ●                       │
└─────────────────────────────────────────────────────────────────────────┘
```

The file tree exposes the project’s structured files, locales, scripts, assets, and retained arbitrary files. Selecting a text file opens it in a tab; modified tabs have a visible dirty marker. Selecting a binary asset shows a safe preview or file details instead of treating bytes as text. Selecting an unsupported file shows its path and that it is retained unchanged.

The diagnostics pane links back to the relevant path or entity when known. File actions such as add, rename, or delete are explicit and labeled. A failed edit or validation does not replace the source with a normalized or partial version.

## Screen 4: Switching modes with a Sage-only script

The mode selector remains in the project header. Switching between modes keeps the same open project. It does not create a second copy, translate scripts, or rewrite untouched files. Current edits remain in the project and in local recovery; show the recovery status in the header.

When a Sage-only script is selected from the **Scripts** section of an Apprentice inspector, show this focused placeholder instead of a visual script editor:

```text
┌ Script: scripts/guard.lua ──────────────────────────────────────────────┐
│ Sage-only source                                                        │
│ This script stays in the project unchanged while you work in            │
│ Apprentice Mode. It is not edited as visual forms here.                  │
│                                                                         │
│ [Open in Sage Mode]                                      [Close details] │
└─────────────────────────────────────────────────────────────────────────┘
```

Selecting the script never attempts conversion or edits its source. **Open in Sage Mode** switches modes and opens the same script path in Sage. **Close details** returns focus to the previous inspector control. Any diagnostic for that script remains visible and can be opened from Diagnostics. If the script path is unavailable, keep the reference visible and offer its diagnostic rather than silently removing it.

## Screen 5: Playtest and debug

Selecting **Playtest** first shows diagnostics requiring acknowledgment, with links to affected content. The author can choose **Continue to playtest** or **Return to editing**. A missing or invalid entry scene produces a clear cannot-start message and a link to the entry diagnostic; it does not silently start at another scene. Keep project ZIP download available.

```text
┌ Lantern Story · Playtest ───────────────────────────────────────────────┐
│ [Return to editing] [Restart from entry]              Locale [Default]  │
├───────────────────────────────────────────┬─────────────────────────────┤
│ Player                                    │ Debug                       │
│                                           │ Current scene: Market       │
│ The market is closing...                 │ State                        │
│                                           │ Trace                        │
│ [Ask the keeper]                          │ 1 action · reason: ...      │
│ [Leave for the alley]                     │ 2 state change · reason:...│
│                                           │ Diagnostics                  │
└───────────────────────────────────────────┴─────────────────────────────┘
```

The left pane presents the same player-facing story and controls as the game. The debug pane presents the current scene, state, ordered action trace, and diagnostics. Each trace change includes its reason. Choosing a trace or diagnostic reveals its source and focuses the corresponding editor location after returning to editing. If play stops on a malformed path or runtime/build error, show the exact diagnostic and retain the project for editing and download.

## Screen 6: Game export

**Export game ZIP** opens a review screen with the game title, validation summary, warning acknowledgment, and an optional **Include generated README** checkbox. Warnings requiring acknowledgment are listed before **Build and download**. Keep each item linked to its source. The export action reports a precise build error if required content cannot be built; it never silently skips a broken path. Offer **Return to editing** and keep **Download project ZIP** available for a recoverable project copy. On success, announce the downloaded game ZIP and explain that it contains `index.html` for direct opening after extraction.

```text
┌ Export game ZIP ────────────────────────────────────────────────────────┐
│ Lantern Story                                                          │
│ Validation: 2 warnings · 0 build errors                 [Review list]  │
│ [x] Include generated README                                           │
│                                                                         │
│ Acknowledge the listed warnings before building.                        │
│                                                                         │
│                           [Return to editing] [Build and download]      │
└─────────────────────────────────────────────────────────────────────────┘
```

## Flow A: First story, no coding experience

1. From **Projects**, choose **New project**, enter a title and default language, then create it.
2. In the empty Apprentice graph, choose **Add first scene**. Enter a scene title and a few lines of story text. The first scene is marked as the entry scene.
3. Choose **Add scene** for the next location. Select **Add navigation connection**, choose the first and second scenes, then add a choice label such as “Go to the alley”.
4. Choose **Playtest**. Review any warnings and acknowledge them to continue. Try the choice in the player pane and read the current scene/trace in Debug.
5. Choose **Return to editing** from the debug view to return to the related scene form. Correct the text or connection indicated by any diagnostic.
6. Choose **Download project ZIP** for a portable authoring copy. If validation findings exist, review and acknowledge the listed diagnostics; the project ZIP remains downloadable even when authored content is invalid.
7. Choose **Export game ZIP** when ready to distribute. Review warnings, acknowledge them, include the optional README if desired, then build and download.

## Flow B: Developer, Sage-first with a visual review

1. From **Projects**, create a project or import a project ZIP. Open **Sage Mode** from the mode selector.
2. Use the file tree to open structured text or a script. Edit in a tab; the modified marker and recovery status remain visible. Unknown and binary files stay represented as files, not rewritten text.
3. Open Diagnostics to inspect a validation message and jump to its source. Resolve it in the relevant file, or keep the authored content for recovery if it is intentionally unfinished.
4. Switch to **Apprentice Mode** to review scene containment, navigation, and forms. If a Sage-only script is selected, the placeholder explains that the source remains unchanged and offers **Open in Sage Mode**.
5. Choose **Playtest** to exercise the story and inspect the ordered trace, state changes, and reasons. Return to the linked Sage file or Apprentice form from a diagnostic.
6. Download the project ZIP for authoring backup. When ready, run **Export game ZIP**, acknowledge warnings, and download the static game archive.

## Empty, loading, and error states

| Context | Empty or loading state | Error state and recovery |
| --- | --- | --- |
| Projects | No recent projects: show **New project** and **Import ZIP**. While importing, announce “Importing project…” and prevent a second import action. | Unsafe or unreadable ZIP: explain the reason, keep the current project unchanged, and offer **Choose another ZIP**. |
| New project | Required fields are labeled; explain any missing value next to the field. | Creation failure: keep entered values and offer retry. |
| Apprentice graph | No scenes: explain scenes and offer **Add first scene**. No selection: prompt to select or add a scene. No outgoing edge: offer **Add connection**. | Invalid field or missing reference: preserve the input, show inline text and a linked diagnostic. |
| Sage file editor | No file selected: prompt to select a file. Empty text file: show an editable blank buffer. While a file opens, announce its path and keep focus predictable. | Unsupported/binary file: show safe details and explain it is retained. Failed edit or read: show the path and error without replacing source bytes. |
| Script in Apprentice | No scripts: show **Add/open in Sage** guidance. Sage-only selection: show the placeholder described above. | Missing or invalid script: preserve the reference/source that exists, show its diagnostic, and provide **Open in Sage Mode** when the path exists. |
| Diagnostics | No findings: show “No diagnostics”. While validation runs, announce that status and keep the editor usable. | Validation failure: show a precise message and location when available; do not clear the diagnostic pane or authored input. |
| Playtest | Before starting, show a brief “Ready to play” state. No trace yet: label it “No actions yet”. | No valid entry: explain why play cannot start and link to the entry setting. Runtime/build failure: show the precise error and return-to-edit action. |
| Recovery | Show “Recovering…” only while recovery is pending; otherwise expose the last recovery status. | Storage/quota failure: visibly state that recovery failed and do not claim the project is backed up. Keep current in-memory work open and offer **Download project ZIP** and **Retry recovery**. |
| Project ZIP download | Show validation findings and required acknowledgment before a deliberate download. | Download failure: keep the project open and dirty status intact; offer retry and show the failure. Invalid authored content does not prevent project ZIP recovery. |
| Game export | Show build progress and warning acknowledgment. | Build failure: give a precise diagnostic and source link. Do not emit a game that silently omits broken content; keep project ZIP download available. |

A dismissible unsaved-work reminder appears after 10–15 minutes of unsaved work. Dismissing it hides the reminder only; it does not mark the project saved or reset its unsaved status.

## Keyboard path and focus behavior

- Use a visible skip link to the main work area. Keep the header controls, mode selector, diagnostics, and project actions reachable in a predictable tab order. Every focused control has a clear visible focus indicator.
- In the Apprentice scene outline, Up/Down moves among scenes and Left/Right collapses or expands contained children when present. Enter selects the scene. In the navigation map, Tab visits nodes and connections in visual order; Enter opens the focused node or connection in the inspector. Provide labeled form controls for adding and connecting scenes so pointer dragging is optional.
- In the Sage file tree, Up/Down moves among siblings, Left/Right collapses or expands folders, and Enter opens the focused file. Standard editor navigation remains available in the text area and editor tabs. Provide a labeled action to return focus to the file tree.
- In the Sage-only script placeholder, Tab reaches **Open in Sage Mode** and **Close details**. Activating either returns focus to the script row or the opened Sage editor, respectively.
- In dialogs, place initial focus on the heading or first relevant control, keep focus within the dialog, and return focus to the control that opened it when closed. Escape cancels only when doing so cannot discard an unconfirmed operation.
- In playtest, choices are buttons, the typed-command field has a visible label, and debug trace rows can be focused and opened. A diagnostic link moves focus to its matching editor field or file.
- Announce import, validation, recovery, download, and export status changes to assistive technology without moving keyboard focus unexpectedly. Do not convey errors, selected modes, or entry-scene status by color alone.
