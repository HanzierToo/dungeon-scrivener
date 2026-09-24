import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'dungeon-scrivener-executor-'));
const browserBundle = resolve(temporaryDirectory, 'executor.js');
const directOpenHtml = resolve(temporaryDirectory, 'direct-open.html');
let bundleSource = '';

beforeAll(async () => {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      lib: { entry: resolve('packages/scripting/src/executor/index.ts'), name: 'DungeonScript', formats: ['iife'], fileName: () => 'executor.js' },
      outDir: temporaryDirectory,
      emptyOutDir: false,
    },
  });
  bundleSource = await readFile(browserBundle, 'utf8');
  await writeFile(directOpenHtml, `<!doctype html><meta charset="utf-8"><script>${bundleSource}</script>`);
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe('browser execution security matrix', () => {
  it('denies ambient capabilities and produces identical hosted/direct-open effects', async () => {
    for (const engine of [chromium, firefox, webkit]) {
      const browser = await engine.launch({ headless: true });
      try {
        const hosted = await browser.newPage();
        const networkRequests: string[] = [];
        await hosted.route('**/*', async (route) => {
          if (!route.request().url().startsWith('about:')) networkRequests.push(route.request().url());
          await route.abort();
        });
        await hosted.goto('about:blank');
        await hosted.addScriptTag({ content: bundleSource });
        const hostedResult = await hosted.evaluate(() => {
          const run = (ir: unknown) => {
            const events: string[] = [];
            const context = {
              origin: { kind: 'action' as const, actionId: 'browser-test' },
              limits: {
                maxInstructions: 50_000, maxCallDepth: 16, maxLoopIterations: 1_000,
                maxAllocatedBytes: 1_048_576, maxStringBytes: 16_384, maxCollectionMembers: 1_024,
                maxValueDepth: 32, maxCapabilityCalls: 10_000, maxRequestedEffects: 256, maxTraceRecords: 20_000,
              },
              capabilities: {
                read: () => 0, hasTag: () => false,
                request: (effect: { kind: string }) => events.push(`effect:${effect.kind}`),
                emit: (id: string) => events.push(`event:${id}`), randomInt: (min: number) => min, randomFloat: () => 0.5,
              },
            };
            const Executor = (window as unknown as { DungeonScript: { ScriptExecutor: new () => { executeScript(input: unknown, inputContext: unknown): { ok: boolean; [key: string]: unknown } } } }).DungeonScript.ScriptExecutor;
            return { result: new Executor().executeScript(ir, context), events };
          };
          const span = { path: 'scripts/browser.js', startLine: 1, startColumn: 1, endLine: 2, endColumn: 80 };
          const literal = (value: string) => ({ kind: 'literal', value, span });
          const forbidden = ['window', 'document', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'WebSocket', 'indexedDB', 'File', 'FileReader', 'showOpenFilePicker', 'showSaveFilePicker', 'process', 'require', 'eval'];
          const attacks = forbidden.flatMap((name) => [
            { format: 'dungeon-scrivener-script-ir', schemaVersion: 1, scriptId: 'browser-attack', sourceLanguage: 'javascript',
              sourcePath: span.path, entrypoint: 'main', functions: [{ name: 'main', parameters: [], span, body: [
                { kind: 'expression', span, expression: { kind: 'call', span, target: { kind: 'helper', name }, arguments: [] } },
              ] }],
            },
            { format: 'dungeon-scrivener-script-ir', schemaVersion: 1, scriptId: 'browser-global', sourceLanguage: 'javascript',
              sourcePath: span.path, entrypoint: 'main', functions: [{ name: 'main', parameters: [], span, body: [
                { kind: 'expression', span, expression: { kind: 'local', name, span } },
              ] }],
            },
          ]);
          const attackResults = attacks.map((ir) => run(ir).result.ok);
          const recursion = {
            format: 'dungeon-scrivener-script-ir', schemaVersion: 1, scriptId: 'browser-recursion', sourceLanguage: 'javascript',
            sourcePath: span.path, entrypoint: 'main', functions: [
              { name: 'main', parameters: [], span, body: [{ kind: 'if', span,
                condition: { kind: 'call', span, target: { kind: 'helper', name: 'again' }, arguments: [] }, then: [], else: [] }] },
              { name: 'again', parameters: [], span, body: [{ kind: 'return', span,
                value: { kind: 'call', span, target: { kind: 'helper', name: 'again' }, arguments: [] } }] },
            ],
          };
          const recursionResult = run(recursion);
          const flood = {
            format: 'dungeon-scrivener-script-ir', schemaVersion: 1, scriptId: 'browser-flood', sourceLanguage: 'javascript',
            sourcePath: span.path, entrypoint: 'main', functions: [{ name: 'main', parameters: [], span,
              body: Array.from({ length: 257 }, () => ({ kind: 'expression', span, expression: {
                kind: 'call', span, target: { kind: 'capability', name: 'api.emit' }, arguments: [literal('flood'), { kind: 'map', entries: [], span }],
              } })) }],
          };
          const floodResult = run(flood);
          const effect = {
            kind: 'map', span,
            entries: [{ key: 'kind', value: literal('navigate') }, { key: 'edgeId', value: literal('next') }],
          };
          const normal = {
            format: 'dungeon-scrivener-script-ir', schemaVersion: 1, scriptId: 'browser-normal', sourceLanguage: 'javascript',
            sourcePath: span.path, entrypoint: 'main', functions: [{ name: 'main', parameters: [], span, body: [
              { kind: 'expression', span, expression: { kind: 'call', span, target: { kind: 'capability', name: 'api.request' }, arguments: [effect] } },
              { kind: 'expression', span, expression: { kind: 'call', span, target: { kind: 'capability', name: 'api.emit' }, arguments: [literal('arrived'), { kind: 'map', entries: [], span }] } },
            ] }],
          };
          const normalResult = run(normal);
          return { attackResults, recursionResult, floodResult, normalResult, documentAvailable: typeof document };
        });

        const direct = await browser.newPage();
        await direct.goto(pathToFileURL(directOpenHtml).href);
        const directResult = await direct.evaluate(() => {
          const run = (ir: unknown) => {
            const events: string[] = [];
            const context = {
              origin: { kind: 'action' as const, actionId: 'browser-test' },
              limits: {
                maxInstructions: 50_000, maxCallDepth: 16, maxLoopIterations: 1_000,
                maxAllocatedBytes: 1_048_576, maxStringBytes: 16_384, maxCollectionMembers: 1_024,
                maxValueDepth: 32, maxCapabilityCalls: 10_000, maxRequestedEffects: 256, maxTraceRecords: 20_000,
              },
              capabilities: {
                read: () => 0, hasTag: () => false,
                request: (effect: { kind: string }) => events.push(`effect:${effect.kind}`),
                emit: (id: string) => events.push(`event:${id}`), randomInt: (min: number) => min, randomFloat: () => 0.5,
              },
            };
            const Executor = (window as unknown as { DungeonScript: { ScriptExecutor: new () => { executeScript(input: unknown, inputContext: unknown): { ok: boolean; [key: string]: unknown } } } }).DungeonScript.ScriptExecutor;
            return { result: new Executor().executeScript(ir, context), events };
          };
          const span = { path: 'scripts/browser.js', startLine: 1, startColumn: 1, endLine: 2, endColumn: 80 };
          const literal = (value: string) => ({ kind: 'literal', value, span });
          const normal = {
            format: 'dungeon-scrivener-script-ir', schemaVersion: 1, scriptId: 'browser-normal', sourceLanguage: 'javascript',
            sourcePath: span.path, entrypoint: 'main', functions: [{ name: 'main', parameters: [], span, body: [
              { kind: 'expression', span, expression: { kind: 'call', span, target: { kind: 'capability', name: 'api.request' }, arguments: [{
                kind: 'map', span, entries: [{ key: 'kind', value: literal('navigate') }, { key: 'edgeId', value: literal('next') }],
              }] } },
              { kind: 'expression', span, expression: { kind: 'call', span, target: { kind: 'capability', name: 'api.emit' }, arguments: [literal('arrived'), { kind: 'map', entries: [], span }] } },
            ] }],
          };
          return run(normal);
        });

        expect(hostedResult.attackResults.every((accepted) => !accepted), engine.name()).toBe(true);
        expect(hostedResult.recursionResult.result.ok, engine.name()).toBe(false);
        expect(JSON.stringify(hostedResult.recursionResult.result.diagnostic), engine.name()).toContain('call depth');
        expect(hostedResult.floodResult.result.ok, engine.name()).toBe(false);
        expect(hostedResult.floodResult.events.filter((event) => event.startsWith('event:'))).toHaveLength(256);
        expect(hostedResult.normalResult.result.ok, `${engine.name()}: ${JSON.stringify(hostedResult.normalResult.result)}`).toBe(true);
        expect(directResult.result.ok, `${engine.name()}: ${JSON.stringify(directResult.result)}`).toBe(true);
        expect(directResult.events, engine.name()).toEqual(hostedResult.normalResult.events);
        expect(hostedResult.documentAvailable, engine.name()).toBe('object');
        expect(networkRequests, engine.name()).toEqual([]);
      } finally {
        await browser.close();
      }
    }
  }, 120_000);
});
