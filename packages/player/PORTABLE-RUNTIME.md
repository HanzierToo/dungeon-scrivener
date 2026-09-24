# Portable player runtime

Build the portable artifacts from the repository root:

```sh
npm --workspace @dungeon-scrivener/player run build:portable
```

The build writes `packages/player/dist/dungeon-scrivener-player.js` and `packages/player/dist/dungeon-scrivener-player.css`. The JavaScript is a classic script with no module imports. It includes the Player UI, Agent 13's public engine factory, and the validated IR executor. The CSS has no external imports or URLs. Both files can be copied beside a generated game HTML file and loaded from `file://`.

Embed the serialized `PortableGameData` in a script element and load the artifacts with ordinary HTML tags:

```html
<link rel="stylesheet" href="dungeon-scrivener-player.css">
<div id="player"></div>
<script id="game-data" type="application/json">{"manifest":{},"world":{},"locales":[],"compiledScripts":{},"sessionStart":{}}</script>
<script src="dungeon-scrivener-player.js"></script>
<script>
  const runtime = window.DungeonScrivenerPlayer;
  const data = runtime.parseEmbeddedData('game-data');
  const host = {
    mediaAssets: {
      resolveAsset(assetId) {
        // Resolve media from the generator's embedded asset map, without fetch.
        return embeddedMediaAssets.resolveAsset(assetId);
      }
    }
  };
  runtime.startFromEmbeddedData(document.getElementById('player'), data, {
    factory: runtime.engine,
    host
  });
</script>
```

`PortableGameData` contains `manifest`, `world`, `locales`, `compiledScripts`, and `sessionStart`. The host supplies `mediaAssets`; the runtime supplies the bundled script executor automatically. `startFromEmbeddedData` returns a handle with `getSnapshot()` and `unmount()`. `window.DungeonScrivenerPlayer` also exposes the engine API namespace, `Player`, and `EnginePlayer`. The executor is available at `window.DungeonScrivenerExecutor`.

The host must resolve game assets from embedded data or another synchronous local mechanism. The runtime itself does not use `fetch`, dynamic imports, or a CDN.

Run the portable browser checks with:

```sh
npm --workspace @dungeon-scrivener/player run test:portable
```

This rebuilds the artifacts, tests script execution and player interaction from a `file://` page, rejects network access, and starts the Tavern fixture with the bundled public engine factory. The browser fixture is test data only; it is not part of the delivered build.
