import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const playerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(playerDirectory, '../..');
const outputDirectory = resolve(playerDirectory, 'dist');
await mkdir(outputDirectory, { recursive: true });
const stagingDirectory = await mkdtemp(resolve(outputDirectory, '.build-'));
const playerStage = resolve(stagingDirectory, 'player');
const executorStage = resolve(stagingDirectory, 'executor');
const engineEntry = resolve(repositoryRoot, 'packages/engine/src/index.ts');
const executorEntry = resolve(repositoryRoot, 'packages/scripting/src/executor/index.ts');
const playerEntry = resolve(playerDirectory, 'src/portable-entry.tsx');
const versionSource = resolve(playerDirectory, 'src/portable-version.ts');
const marker = '<!--DUNGEON_SCRIVENER_EMBEDDED_GAME_DATA-->';

async function publish(name, content) {
  const stagedPath = resolve(stagingDirectory, name);
  await writeFile(stagedPath, content);
  await rename(stagedPath, resolve(outputDirectory, name));
}

await build({
  configFile: false,
  root: repositoryRoot,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias: {
    '@dungeon-scrivener/engine': engineEntry,
    '@dungeon-scrivener/player-save': resolve(repositoryRoot, 'packages/player-save/src/index.ts'),
  } },
  build: {
    lib: { entry: playerEntry, name: 'DungeonScrivenerPlayer', formats: ['iife'], fileName: () => 'player.js' },
    outDir: playerStage,
    emptyOutDir: true,
    cssCodeSplit: false,
  },
});

await build({
  configFile: false,
  root: repositoryRoot,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: { entry: executorEntry, name: 'DungeonScrivenerExecutor', formats: ['iife'], fileName: () => 'executor.js' },
    outDir: executorStage,
    emptyOutDir: true,
  },
});

const playerScript = await readFile(resolve(playerStage, 'player.js'), 'utf8');
const executorScript = await readFile(resolve(executorStage, 'executor.js'), 'utf8');
const runtime = `${playerScript}\n;${executorScript}\n`;
const css = await readFile(resolve(playerStage, 'dungeon-scrivener.css'), 'utf8');
const versionMatch = /PORTABLE_PLAYER_ENGINE_VERSION\s*=\s*'([^']+)'/u.exec(await readFile(versionSource, 'utf8'));
if (!versionMatch) throw new Error('Portable player engine compatibility version is not defined.');
const engineVersion = versionMatch[1];
const inlineRuntime = runtime.replace(/<\/script/giu, '<\\/script');
if (/<\/style/iu.test(css)) throw new Error('Portable player CSS contains a closing style tag and cannot be embedded safely.');
const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Dungeon Scrivener Game</title>\n<style>${css}</style>\n</head>\n<body>\n<div id="player-root"></div>\n${marker}\n<script>${inlineRuntime}</script>\n</body>\n</html>\n`;
const artifactModule = `export const portablePlayerArtifact = Object.freeze({ format: 'dungeon-scrivener-portable-player', schemaVersion: 1, engineVersion: ${JSON.stringify(engineVersion)}, indexHtml: new TextEncoder().encode(${JSON.stringify(html)}) });\nexport function getPortablePlayerArtifact() { return { ...portablePlayerArtifact, indexHtml: portablePlayerArtifact.indexHtml.slice() }; }\n`;
const artifactTypes = `import type { PortablePlayerArtifact } from '@dungeon-scrivener/model';\nexport declare const portablePlayerArtifact: PortablePlayerArtifact;\nexport declare function getPortablePlayerArtifact(): PortablePlayerArtifact;\n`;
await publish('dungeon-scrivener-player.js', runtime);
await publish('dungeon-scrivener-player.css', css);
await publish('portable-artifact.js', artifactModule);
await publish('portable-artifact.d.ts', artifactTypes);
await rm(stagingDirectory, { recursive: true, force: true });
console.log(`Portable player written to ${outputDirectory}`);
