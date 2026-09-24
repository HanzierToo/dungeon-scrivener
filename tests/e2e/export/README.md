# Task 28B export browser evidence

## Run

Build Agent 22's portable runtime, then run the export suite from the repository root:

```sh
npm --workspace @dungeon-scrivener/player run build:portable
npx playwright test tests/e2e/export/export.spec.ts --config=playwright.config.ts
```

The spec compiles the Tavern's JS, Lua, and Python sources, passes Agent 22's standalone runtime artifact and Agent 13's compiled bundle through `exportGame`, extracts the resulting ZIP to a temporary directory, and opens `index.html` through `file://`. HTTP and HTTPS requests are blocked; local files and blob URLs remain available.

## Result on 2026-09-24

| Browser engine | Playwright version | Direct open, assets, navigation, clock/script cascade, locale projection, startup diagnostic | Wiki node link | Save/load controls |
| --- | --- | --- | --- | --- |
| Chromium | 153.0.8010.12 | Pass | Fail: wiki target is not rendered as a link | Fail: no portable save or load controls |
| Firefox | 155.0 | Pass | Fail: wiki target is not rendered as a link | Fail: no portable save or load controls |
| WebKit | 26.6 | Pass | Fail: wiki target is not rendered as a link | Fail: no portable save or load controls |

Run result: **6 passed, 6 failed**. Each engine passed the direct-open/runtime and invalid-entry diagnostic cases. Each engine failed the node-link and save/load-control acceptance cases. Passing runtime checks recorded zero HTTP(S) requests and zero uncaught page exceptions. The script cascade produced the expected 120,000 ms bounded resume, trust increment from Lua, deterministic recorded random result from JavaScript, and Rowan tag from Python. Japanese locale projection returned `酒場の広間`. PNG and WAV assets resolved from the embedded game data, and the image rendered.

Sample Tavern export ZIP SHA-256: `2e98fe9ad95f4cf60294dd052b7276d84f52611a8605da846661d254c0a46d9b`.

The failure evidence points to functionality absent from the supplied portable player artifact: `Player` does not render `node-link` inline nodes as navigable links, and `portable-entry.tsx` does not expose save/download/import controls or the player-save codec. These behaviors cannot be repaired in the task 28B-owned paths without recreating or changing Agent 22/27 runtime behavior. The automated checks remain as acceptance coverage; 28B is not accepted until the owning upstream runtime is extended and these checks pass.

Chrome/Edge branded-browser smoke checks were not run separately. The WebKit result is Playwright WebKit, not Safari manual evidence.
