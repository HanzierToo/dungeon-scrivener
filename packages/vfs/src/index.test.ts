import { describe, expect, it } from 'vitest';
import type { ProjectFile } from '@dungeon-scrivener/model';
import {
  addProjectFile,
  addProjectDirectory,
  createSnapshot,
  deleteProjectPath,
  hashManagedAsset,
  pathComparisonKey,
  readProjectFile,
  renameProjectPath,
  VfsError
} from './index.js';

function file(path: string, bytes: Uint8Array, role: ProjectFile['role'] = 'arbitrary'): ProjectFile {
  return { path, bytes, role };
}

describe('project VFS', () => {
  it('normalizes comparison keys while retaining Unicode path spelling', () => {
    expect(pathComparisonKey('chapters/東京.md')).toBe('chapters/東京.md');
    const snapshot = createSnapshot([file('chapters/東京.md', new TextEncoder().encode('# 夜\n'))]);
    expect([...snapshot.files.keys()]).toEqual(['chapters/東京.md']);
  });

  it.each(['../escape', 'a/../escape', '/absolute', '\\leading', 'a//b', 'a\\b', 'a:b', 'bad\u0000name', 'e\u0301.txt', 'CON', 'name.']) (
    'rejects unsafe path %j', path => {
      expect(() => createSnapshot([file(path, new Uint8Array())])).toThrow(VfsError);
    }
  );

  it('rejects duplicate and case-colliding paths without returning a partial snapshot', () => {
    expect(() => createSnapshot([
      file('Assets/map.png', new Uint8Array([1])),
      file('assets/MAP.png', new Uint8Array([2]))
    ])).toThrowError(expect.objectContaining({ code: 'DS-VFS-COLLISION' }));
  });

  it('preserves empty and arbitrary binary/text bytes exactly', () => {
    const manifest = new TextEncoder().encode('{\n  "projectId": "byte-test", // author comment\n}\n');
    const binary = new Uint8Array([0, 255, 1, 128, 0, 42]);
    const empty = new Uint8Array();
    const snapshot = createSnapshot([
      file('project.json', manifest, 'manifest'),
      file('notes.txt', new TextEncoder().encode('# keep this comment\n<!-- unchanged -->\n')),
      file('raw.bin', binary),
      file('empty.bin', empty)
    ]);
    expect(snapshot.projectId).toMatch(/^recovery-[a-f0-9]{32}$/u);
    expect(readProjectFile(snapshot, 'PROJECT.JSON')?.bytes).toEqual(manifest);
    expect(readProjectFile(snapshot, 'notes.txt')?.bytes).toEqual(new TextEncoder().encode('# keep this comment\n<!-- unchanged -->\n'));
    expect(readProjectFile(snapshot, 'raw.bin')?.bytes).toEqual(binary);
    expect(readProjectFile(snapshot, 'empty.bin')?.bytes).toEqual(empty);
    expect(snapshot.files.get('project.json')?.bytes).toEqual(manifest);
  });

  it('uses a valid manifest ID even when the rest of the manifest is invalid', () => {
    const bytes = new TextEncoder().encode('{"projectId":"stable-id","unknown":true}');
    const snapshot = createSnapshot([file('project.json', bytes)]);
    expect(snapshot.projectId).toBe('stable-id');
    expect(snapshot.files.get('project.json')?.bytes).toEqual(bytes);
  });

  it('makes add and rename atomic when the destination collides', () => {
    const original = createSnapshot([
      file('project.json', new TextEncoder().encode('{"projectId":"atomic"}')),
      file('a.bin', new Uint8Array([7]))
    ]);
    expect(() => renameProjectPath(original, 'a.bin', 'project.JSON')).toThrow(VfsError);
    expect(() => addProjectFile(original, file('A.BIN', new Uint8Array([8])))).toThrow(VfsError);
    expect([...original.files.keys()]).toEqual(['project.json', 'a.bin']);
    expect(original.files.get('a.bin')?.bytes).toEqual(new Uint8Array([7]));
  });

  it('keeps directory subtree operations atomic and rejects file-parent conflicts', () => {
    const original = createSnapshot([
      file('project.json', new TextEncoder().encode('{"projectId":"tree"}')),
      file('chapter/scene.txt', new TextEncoder().encode('scene'))
    ], ['chapter', 'chapter/empty']);
    const withDirectory = addProjectDirectory(original, 'art');
    const renamed = renameProjectPath(withDirectory, 'chapter', 'chapters');
    expect([...renamed.files.keys()]).toContain('chapters/scene.txt');
    expect([...renamed.directories]).toContain('chapters/empty');
    expect([...original.files.keys()]).toContain('chapter/scene.txt');
    const deleted = deleteProjectPath(renamed, 'chapters');
    expect([...deleted.files.keys()]).not.toContain('chapters/scene.txt');
    expect([...deleted.directories]).not.toContain('chapters/empty');
    expect(() => addProjectFile(original, file('chapter', new Uint8Array([1])))).toThrow(VfsError);
  });

  it('hashes identical managed asset bytes to the same content digest', async () => {
    const first = new Uint8Array([0, 1, 2, 255]);
    const second = new Uint8Array([0, 1, 2, 255]);
    await expect(hashManagedAsset(first)).resolves.toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expect(hashManagedAsset(second)).resolves.toEqual(await hashManagedAsset(first));
  });
});

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { readProjectZip, writeProjectZip } from './index.js';

async function fixtureFiles(root: string, current = root): Promise<ProjectFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: ProjectFile[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await fixtureFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(file(relative(root, absolute).split('\\').join('/'), new Uint8Array(await readFile(absolute))));
    }
  }
  return files;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function findSignature(bytes: Uint8Array, signature: number): number {
  for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
    if ((bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0 === signature) return offset;
  }
  return -1;
}

describe('project ZIP', () => {
  it('round-trips every tavern fixture path and untouched byte sequence', async () => {
    const sourceFiles = await fixtureFiles(join(process.cwd(), 'fixtures/tavern-at-dusk'));
    const source = createSnapshot(sourceFiles);
    const imported = await readProjectZip(await writeProjectZip(source));
    const reimported = await readProjectZip(await writeProjectZip(imported));
    expect([...reimported.files.keys()].sort()).toEqual([...source.files.keys()].sort());
    for (const [path, original] of source.files) {
      const actual = reimported.files.get(path)?.bytes;
      expect(actual, path).toBeDefined();
      expect(sha256(actual!), path).toBe(sha256(original.bytes));
    }
  });

  it('preserves malformed manifest and arbitrary bytes through reimport', async () => {
    const malformed = new TextEncoder().encode('{ not valid JSON // keep bytes\n');
    const opaque = new Uint8Array([0, 255, 1, 8, 13]);
    const source = createSnapshot([
      file('project.json', malformed),
      file('odd data.bin', opaque)
    ]);
    const imported = await readProjectZip(await writeProjectZip(source));
    const reimported = await readProjectZip(await writeProjectZip(imported));
    expect(imported.projectId).toMatch(/^recovery-[a-f0-9]{32}$/u);
    expect(reimported.projectId).toMatch(/^recovery-[a-f0-9]{32}$/u);
    expect(reimported.projectId).not.toBe(imported.projectId);
    expect(reimported.files.get('project.json')?.bytes).toEqual(malformed);
    expect(reimported.files.get('odd data.bin')?.bytes).toEqual(opaque);
  });

  it('rejects traversal paths and reserved-path casing', async () => {
    await expect(readProjectZip(zipSync({ '../escape.txt': new Uint8Array([1]) }))).rejects.toThrow(VfsError);
    await expect(readProjectZip(zipSync({ 'Project.json': new Uint8Array([1]) }))).rejects.toThrow(/Reserved project file paths/u);
  });

  it('rejects members whose expanded content does not match the recorded CRC', async () => {
    const archive = zipSync({ 'crc.txt': new Uint8Array([11, 12, 13]) });
    const corrupted = new Uint8Array(archive);
    const local = findSignature(corrupted, 0x04034b50);
    const central = findSignature(corrupted, 0x02014b50);
    corrupted[local + 14] ^= 1;
    corrupted[central + 16] ^= 1;
    await expect(readProjectZip(corrupted)).rejects.toThrow(/CRC-32/u);
  });

  it('enforces declared limits before extraction and actual streaming output limits', async () => {
    const raw = new Uint8Array(20).fill(65);
    const bounded = zipSync({ 'large.txt': [raw, { level: 6 }] });
    await expect(readProjectZip(bounded, {
      maxArchiveBytes: 1024,
      maxExpandedBytes: 1024,
      maxEntryBytes: 10,
      maxEntries: 10,
      maxPathBytes: 100
    })).rejects.toThrow(/64 MiB|size limit/u);

    const forged = new Uint8Array(bounded);
    const local = findSignature(forged, 0x04034b50);
    const central = findSignature(forged, 0x02014b50);
    expect(local).toBeGreaterThanOrEqual(0);
    expect(central).toBeGreaterThanOrEqual(0);
    forged[local + 22] = 10;
    forged[local + 23] = 0;
    forged[local + 24] = 0;
    forged[local + 25] = 0;
    forged[central + 24] = 10;
    forged[central + 25] = 0;
    forged[central + 26] = 0;
    forged[central + 27] = 0;
    await expect(readProjectZip(forged, {
      maxArchiveBytes: 1024,
      maxExpandedBytes: 1024,
      maxEntryBytes: 10,
      maxEntries: 10,
      maxPathBytes: 100
    })).rejects.toThrow(/Actual ZIP expansion/u);
  });
});
