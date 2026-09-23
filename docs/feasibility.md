# Task 1A . Direct-open feasibility

Status: **Pending acceptance.** The latest Playwright run passes the complete direct-open flow in Chromium and Firefox, including the save ZIP download/import round-trip from the extracted ZIP artifact. Playwright WebKit still fails before the main `file://` document loads. The user-provided Safari screenshots show that Safari opened the page and loaded its local PNG/WAV, but they do not show the full action and save round-trip or enough request detail to close the WebKit evidence gap. The user explicitly authorized continuing the 1B and 1C contract/fixture work while this 1A acceptance gate remains pending.

## Spike

`spikes/direct-open/index.html` is a tiny local game with one inline classic JavaScript runtime, Unicode story text, relative PNG and WAV media, and a stored-ZIP player-save download/import flow. Its user-script example is hosted in an `allow-scripts` iframe without `allow-same-origin`; it reads snapshots and requests a single typed effect through a postMessage bridge. It probes parent-DOM, local-storage, network, and another local-file access. The CSP denies connections and remote media. This is a feasibility example, not a production script runtime or a claim that arbitrary hostile code is harmless.

The regenerated archive is `spikes/direct-open/dungeon-scrivener-direct-open.zip` (55,231 bytes, SHA-256 `2c42eb4492aad27f1892d24119ea88c7c45ff922c1af6884434a827ee219adf0`). Rebuild it with `npm run build:zip`; the archive contains `index.html`, `assets/lantern-map.png`, and `assets/night-birds.wav` as stored ZIP entries. A separate local player-save ZIP is produced and imported by the page.

## Latest automated browser run

`spikes/direct-open/evidence/browser-results.json` is the corrected rerun. The verifier extracts the generated archive to a fresh temporary directory, checks exact stored members and byte identity against the spike source, then tests that extracted index.html directly by file URL. The initial report is preserved as `spikes/direct-open/evidence/browser-results-initial.json`. The verification command exits 1 because WebKit fails before page load; Chromium and Firefox results still pass.

| Browser | Result | Evidence |
| --- | --- | --- |
| Chromium 153.0.8010.12 | **PASS** | Opened the `file:` page with networking disabled. Unicode, one inline classic script, 192 × 128 PNG, WAV, opaque frame and bridge probes passed. Both story actions worked. Downloaded a 266-byte save ZIP and imported it, restoring `courage=2` and `chaptersSeen=2`. Requests were only the local HTML, PNG, and WAV. No failed requests or page errors. |
| Firefox 155.0 | **PASS** | Same complete story, media, isolation, action, and save round-trip checks passed. No failed requests or page errors. The sandbox's attempted `/etc/hosts` access was denied with a `moz-nullprincipal` security error. |
| Playwright WebKit 26.6 | **FAIL before page load** | The main `file://` document request failed with `WebKit encountered an internal error`. Page content and all page-level checks were not reached. This result alone does not distinguish a page limitation from a Playwright WebKit navigation/environment failure. |

Chromium's console records CSP errors for the page's deliberate fetch attempts to `https://example.invalid/no-network` and `file:///etc/hosts`. Firefox similarly records the expected blocked probes. These errors are evidence of the rejection checks, not unexpected page failures. Safari may phrase the CSP denial as a URL not appearing in `connect-src`; that wording is also consistent with the current `connect-src 'none'` policy.

## User-provided Safari screenshots

The screenshots show the page open at a `file://` URL and the media status `PASS: local PNG and WAV loaded.` The Console screenshot also shows the expected denied network and local-file probes. The Network screenshot shows resource names and file types, but its visible columns do not expose enough full URLs to independently classify every request. The screenshots do not show the story-action result or a save ZIP download followed by import. They are useful partial WebKit evidence, not a completed acceptance run.

## Browser matrix

| Engine / route | Direct open | Choice/action | Local PNG/WAV | Save ZIP download/import | Isolation probes | No-network evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium / Playwright | Pass | Pass | Pass | Pass; state restored | Pass; opaque origin and probes blocked | Only local HTML/PNG/WAV requests; no HTTP or failures |
| Firefox / Playwright | Pass | Pass | Pass | Pass; state restored | Pass; opaque origin and probes blocked | No failed requests; intentional external/local-file probes denied |
| WebKit / Playwright | Failed at main document navigation | Not reached | Not reached | Not reached | Not reached | Main file request failed before page checks |
| Safari / user screenshots | Page shown at `file://` URL | Not evidenced | Page reports pass | Not evidenced | Console shows deliberate fetches denied; full report not shown | Network screenshot lacks readable full request URLs |

## Remaining 1A check

Use a fresh extraction of `dungeon-scrivener-direct-open.zip` and open that extracted `index.html` in Safari. Confirm the visible media and isolation statuses say `PASS`, click **Light the lantern** and **Follow the blue trail**, then download a save ZIP. Import that same ZIP after making another action. The imported state should return to the saved values (`courage=2`, `chaptersSeen=2` for the verifier's sequence). In Web Inspector, capture the resulting status/trace and the Network list with full URLs visible so that the local file requests and absence of HTTP requests can be checked. If Safari completes those checks, record Safari as the WebKit manual pass and retain the Playwright WebKit startup failure as a harness limitation. If a required behavior fails in Safari, report the smallest contract fallback and pause the dependent chain.

The Playwright WebKit failure is an observed test result. No product contract change is proposed from it alone.
