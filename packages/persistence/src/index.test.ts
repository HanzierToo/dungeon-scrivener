import { describe, expect, it } from 'vitest';
import { createSnapshot, writeProjectZip } from '@dungeon-scrivener/vfs';
import { loadRecovery, saveRecovery } from './index.js';
import { createAuthoringStatus, getRecoveryRestorePrompt, SAVE_REMINDER_DELAY_MS } from './authoring-status.js';

type StoredRecord = { projectId: string; [key: string]: unknown };

class TestDatabase {
  closed = false;
  onUpgrade?: (database: TestDatabase) => void;
  constructor(readonly records: Map<string, StoredRecord>, readonly factory: TestFactory) {}
  get objectStoreNames() {
    return { contains: () => true };
  }
  createObjectStore() { return {}; }
  close() { this.closed = true; }
  transaction(_name: string, mode: string) {
    const transaction = new TestTransaction(this.records, mode, this.factory);
    return transaction as unknown as IDBTransaction;
  }
}

class TestTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: DOMException | null = null;
  constructor(private readonly records: Map<string, StoredRecord>, private readonly mode: string, private readonly factory: TestFactory) {}
  objectStore() {
    return {
      put: (record: StoredRecord) => {
        queueMicrotask(() => {
          if (this.factory.nextWriteError !== undefined) {
            this.error = this.factory.nextWriteError;
            this.factory.nextWriteError = undefined;
            this.onabort?.();
            return;
          }
          this.records.set(record.projectId, structuredClone(record));
          this.oncomplete?.();
        });
        return {};
      },
      get: (key: string) => {
        const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void; error?: DOMException } = {};
        queueMicrotask(() => {
          request.result = this.records.has(key) ? structuredClone(this.records.get(key)) : undefined;
          request.onsuccess?.();
          this.oncomplete?.();
        });
        return request;
      },
      delete: (key: string) => {
        queueMicrotask(() => {
          if (this.mode === 'readwrite') this.records.delete(key);
          this.oncomplete?.();
        });
        return {};
      }
    };
  }
}

class TestFactory {
  readonly records = new Map<string, StoredRecord>();
  nextWriteError?: DOMException;
  lastDatabase?: TestDatabase;
  open() {
    const request: {
      result?: TestDatabase;
      error?: DOMException;
      onupgradeneeded?: () => void;
      onsuccess?: () => void;
      onerror?: () => void;
      onblocked?: () => void;
    } = {};
    queueMicrotask(() => {
      const database = new TestDatabase(this.records, this);
      this.lastDatabase = database;
      request.result = database;
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

function project(audioBytes: Uint8Array) {
  return createSnapshot([
    {
      path: 'project.json',
      bytes: new TextEncoder().encode('{"projectId":"recovery-test"}'),
      role: 'manifest'
    },
    { path: 'assets/sha256/audio', bytes: audioBytes, role: 'asset', mediaType: 'audio/mpeg' }
  ]);
}

describe('IndexedDB project recovery', () => {
  it('closes and reloads a snapshot with a large audio asset', async () => {
    const factory = new TestFactory();
    const bytes = new Uint8Array(256 * 1024).fill(73);
    const original = project(bytes);

    expect(await saveRecovery(original, { indexedDB: factory as unknown as IDBFactory })).toEqual({ ok: true });
    expect(factory.lastDatabase?.closed).toBe(true);

    const restored = await loadRecovery(original.projectId, { indexedDB: factory as unknown as IDBFactory });
    expect(restored.ok).toBe(true);
    if (!restored.ok || restored.snapshot === null) throw new Error('Expected a recovery snapshot.');
    expect(restored.snapshot.files.get('assets/sha256/audio')?.bytes).toEqual(bytes);
    expect(restored.snapshot.files.get('assets/sha256/audio')?.mediaType).toBe('audio/mpeg');
    expect(factory.lastDatabase?.closed).toBe(true);
  });

  it('keeps the previous recovery commit after quota failure and leaves current work exportable', async () => {
    const factory = new TestFactory();
    const previous = project(new Uint8Array([1, 2, 3]));
    const current = project(new Uint8Array([4, 5, 6, 7]));
    const options = { indexedDB: factory as unknown as IDBFactory };

    expect((await saveRecovery(previous, options)).ok).toBe(true);
    factory.nextWriteError = new DOMException('Storage quota reached.', 'QuotaExceededError');
    const failed = await saveRecovery(current, options);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error('Expected the simulated quota failure.');
    expect(failed.diagnostic.code).toBe('DS-PERSISTENCE-QUOTA');

    const restored = await loadRecovery(previous.projectId, options);
    expect(restored.ok).toBe(true);
    if (!restored.ok || restored.snapshot === null) throw new Error('Expected the prior recovery snapshot.');
    expect(restored.snapshot.files.get('assets/sha256/audio')?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    await expect(writeProjectZip(current)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('offers a recovery restore prompt when a new tab session finds a saved snapshot', async () => {
    const factory = new TestFactory();
    const original = project(new Uint8Array([9, 8, 7]));
    const options = { indexedDB: factory as unknown as IDBFactory };
    expect((await saveRecovery(original, options)).ok).toBe(true);

    const prompt = await getRecoveryRestorePrompt(original.projectId, options);
    expect(prompt.state).toBe('available');
    if (prompt.state !== 'available') throw new Error('Expected recovery to be available after reload.');
    expect(prompt.snapshot.files.get('assets/sha256/audio')?.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(prompt.savedAt).toBeGreaterThan(0);
  });
});

describe('authoring dirty state and save reminder', () => {
  it('shows the reminder after twelve minutes, keeps dirty state on dismissal, and reopens after later edits', () => {
    let time = 10_000;
    const status = createAuthoringStatus({ now: () => time });

    status.markEdited();
    expect(status.getStatus()).toMatchObject({ dirty: true, unsavedSince: time, saveReminderVisible: false });
    time += SAVE_REMINDER_DELAY_MS;
    expect(status.getStatus().saveReminderVisible).toBe(true);

    status.dismissSaveReminder();
    expect(status.getStatus()).toMatchObject({ dirty: true, unsavedSince: 10_000, saveReminderVisible: false });
    time += 1_000;
    status.markEdited();
    expect(status.getStatus().saveReminderVisible).toBe(false);
    time += SAVE_REMINDER_DELAY_MS;
    expect(status.getStatus().saveReminderVisible).toBe(true);
  });

  it('keeps recovery autosaves separate from deliberate ZIP exports', () => {
    let time = 50_000;
    const status = createAuthoringStatus({ now: () => time });
    status.markEdited();
    time += 2_000;
    status.markRecoverySaved(time);
    expect(status.getStatus()).toMatchObject({ dirty: true, recoverySavedAt: time, lastExportedAt: null });

    time += 3_000;
    status.markProjectZipExported(time);
    expect(status.getStatus()).toMatchObject({
      dirty: false,
      unsavedSince: null,
      recoverySavedAt: 52_000,
      lastExportedAt: time,
      saveReminderVisible: false
    });
  });
});
