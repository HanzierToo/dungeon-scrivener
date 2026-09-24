import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const playerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(playerDirectory, '../..');
const outputDirectory = resolve(playerDirectory, 'dist');
const stagingDirectory = resolve(outputDirectory, '.build');
const playerStage = resolve(stagingDirectory, 'player');
const executorStage = resolve(stagingDirectory, 'executor');
const engineEntry = resolve(repositoryRoot, 'packages/engine/src/index.ts');
const executorEntry = resolve(repositoryRoot, 'packages/scripting/src/executor/index.ts');
const playerEntry = resolve(playerDirectory, 'src/portable-entry.tsx');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(playerStage, { recursive: true });
await mkdir(executorStage, { recursive: true });

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
await writeFile(resolve(outputDirectory, 'dungeon-scrivener-player.js'), `${playerScript}\n;${executorScript}\n`);
await cp(resolve(playerStage, 'dungeon-scrivener.css'), resolve(outputDirectory, 'dungeon-scrivener-player.css'));
await rm(stagingDirectory, { recursive: true, force: true });
console.log(`Portable player written to ${outputDirectory}`);
