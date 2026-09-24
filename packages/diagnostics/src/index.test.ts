import { describe, expect, it } from 'vitest';
import linearWorld from '../../../fixtures/linear-three-nodes/world.json';
import linearManifest from '../../../fixtures/linear-three-nodes/project.json';
import linearLocale from '../../../fixtures/linear-three-nodes/locales/en-GB.json';
import {
  canSaveProjectZip,
  collectDiagnostics,
  createPlayStartFailureScreen,
  getAcknowledgementStatus,
  getPlayStartBlockers,
  requiresWarningAcknowledgement,
} from './index.js';

function collect(world: unknown, locale: unknown = linearLocale) {
  return collectDiagnostics({
    manifest: linearManifest,
    world,
    locales: { 'locales/en-GB.json': locale },
    filePaths: new Set(['project.json', 'world.json', 'locales/en-GB.json']),
    assetHashes: new Set(),
  }).diagnostics;
}

describe('diagnostic aggregation', () => {
  it('retains source paths, stable entity IDs, and fix hints for model diagnostics', () => {
    const world = structuredClone(linearWorld) as any;
    world.navigationEdges = world.navigationEdges.filter((edge: { id: string }) => edge.id !== 'bridge-to-home');
    world.nodes.find((node: { id: string }) => node.id === 'old-gate').actions.choices[0].navigationEdgeId = 'missing-edge';
    const diagnostics = collect(world);
    expect(diagnostics.some((item) => item.code === 'DS-MOD-024' && item.entityId && item.suggestedFix)).toBe(true);
    expect(diagnostics.some((item) => item.code === 'DS-MOD-031' && item.entityId === 'lantern-house' && item.path === 'world.json')).toBe(true);
  });

  it('aggregates unresolved stable-ID Markdown links, locale fallback, and missing assets', () => {
    const world = structuredClone(linearWorld) as any;
    const node = world.nodes.find((item: { id: string }) => item.id === 'old-gate');
    node.content = { kind: 'literal', text: '[[node:not-a-node]] ![[asset:sha256:' + 'a'.repeat(64) + ']]' };
    const locale = structuredClone(linearLocale) as { strings: Record<string, string> };
    delete locale.strings['gate-title'];
    const diagnostics = collect(world, locale);
    expect(diagnostics.some((item) => item.code === 'DS-MOD-032' && item.path === 'world.json' && item.entityId)).toBe(true);
    expect(diagnostics.some((item) => item.code === 'DS-I18N-001' && item.path && item.entityId === 'old-gate')).toBe(true);
    expect(diagnostics.some((item) => item.code === 'DS-MD-005' && item.path === 'world.json')).toBe(true);
  });

  it('requires acknowledgment for warnings and keeps play blockers separately available', () => {
    const world = structuredClone(linearWorld) as any;
    world.navigationEdges = world.navigationEdges.filter((edge: { id: string }) => edge.id !== 'bridge-to-home');
    const diagnostics = collect(world);
    const warning = diagnostics.find((item) => item.severity === 'warning');
    expect(warning).toBeDefined();
    expect(getAcknowledgementStatus(diagnostics, 'export').required).toBe(true);
    expect(getAcknowledgementStatus(diagnostics, 'export', new Set(warning ? [warning.code] : [])).acknowledged).toBe(true);
    expect(getPlayStartBlockers(diagnostics).every((item) => item.severity !== 'warning')).toBe(true);
  });

  it('aggregates compiler, runtime, rule-budget, fingerprint, and save-compatibility failures', () => {
    const diagnostics = collectDiagnostics({
      manifest: linearManifest,
      world: linearWorld,
      diagnosticReports: [{
        format: 'dungeon-scrivener-diagnostics', schemaVersion: 1,
        diagnostics: [
          { code: 'DS-SCRIPT-002', severity: 'error', message: 'Unsupported source syntax.', path: 'scripts/scene.js', blocks: ['play', 'export'] },
          { code: 'DS-SCRIPT-RUNTIME', severity: 'error', message: 'Script instruction budget exhausted.', path: 'scripts/scene.js', blocks: ['play', 'export'] },
          { code: 'DS-ENG-003', severity: 'error', message: 'Event queue exceeded its budget.', blocks: ['play'] },
        ],
      }],
      fingerprintFailure: {
        ok: false,
        diagnostics: { format: 'dungeon-scrivener-diagnostics', schemaVersion: 1, diagnostics: [
          { code: 'DS-MOD-015', severity: 'error', message: 'Referenced content is missing.', path: 'world.json', blocks: ['play', 'export'] },
        ] },
      },
      saveCompatibility: { compatible: false, mismatches: ['contentFingerprint'] },
    });
    expect(diagnostics.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'DS-SCRIPT-002', 'DS-SCRIPT-RUNTIME', 'DS-ENG-003', 'DS-MOD-015', 'DS-SAVE-005',
    ]));
    const screen = createPlayStartFailureScreen(diagnostics.diagnostics);
    expect(screen?.title).toBe('Unable to start this game');
    expect(screen?.summary).toContain('Unsupported source syntax');
    expect(canSaveProjectZip(diagnostics.diagnostics)).toBe(true);
  });

  it('requires deliberate-action acknowledgment while recovery autosave stays nonblocking', () => {
    const warning = {
      code: 'DS-MOD-031', severity: 'warning' as const, message: 'Node is unreachable.',
      acknowledgementRequired: ['save-project', 'play', 'export'] as const,
    };
    expect(requiresWarningAcknowledgement([warning], 'save-project')).toBe(true);
    expect(requiresWarningAcknowledgement([warning], 'play')).toBe(true);
    expect(requiresWarningAcknowledgement([warning], 'export')).toBe(true);
    expect(requiresWarningAcknowledgement([warning], 'recovery-autosave')).toBe(false);
  });
});
