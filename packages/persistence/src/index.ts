import type { Diagnostic, ProjectFile, ProjectId, ProjectVfsSnapshot, VfsPath } from '@dungeon-scrivener/model';
import { createSnapshot } from '@dungeon-scrivener/vfs';

const DATABASE_NAME = 'dungeon-scrivener-recovery';
const DATABASE_VERSION = 1;
const STORE_NAME = 'snapshots';
const RECORD_VERSION = 1;

interface PersistedFile {
  readonly path: VfsPath;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

interface RecoveryRecord {
  readonly projectId: ProjectId;
  readonly format: 'dungeon-scrivener-recovery-snapshot';
  readonly schemaVersion: number;
  readonly savedAt: number;
  readonly directories: readonly VfsPath[];
  readonly files: readonly PersistedFile[];
}

export interface RecoveryOptions {
  readonly indexedDB?: IDBFactory;
  readonly databaseName?: string;
}

export interface RecoverySuccess {
  readonly ok: true;
}

export interface RecoveryFailure {
  readonly ok: false;
  readonly diagnostic: Diagnostic;
}

export type RecoveryOperationResult = RecoverySuccess | RecoveryFailure;

export type LoadRecoveryResult =
  | { readonly ok: true; readonly snapshot: ProjectVfsSnapshot | null; readonly savedAt: number | null }
  | RecoveryFailure;

function storageDiagnostic(error: unknown): Diagnostic {
  const name = error instanceof DOMException ? error.name :
    typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
      ? error.name
      : '';
  if (name === 'QuotaExceededError') {
    return {
      code: 'DS-PERSISTENCE-QUOTA',
      severity: 'error',
      message: 'Local recovery storage is full. Your current project is still available in memory. Export a project ZIP before closing this page.'
    };
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return {
      code: 'DS-PERSISTENCE-DENIED',
      severity: 'error',
      message: 'The browser denied local recovery storage. Your current project is still available in memory. Export a project ZIP before closing this page.'
    };
  }
  return {
    code: 'DS-PERSISTENCE-FAILED',
    severity: 'error',
    message: 'Local recovery storage failed. Your current project is still available in memory. Export a project ZIP before closing this page.'
  };
}

function getFactory(options: RecoveryOptions): IDBFactory {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) throw new DOMException('IndexedDB is unavailable.', 'NotSupportedError');
  return factory;
}

function openDatabase(options: RecoveryOptions): Promise<IDBDatabase> {
  const factory = getFactory(options);
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(options.databaseName ?? DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'projectId' });
      }
    };
    request.onerror = () => reject(request.error ?? new Error('Unable to open recovery storage.'));
    request.onblocked = () => reject(new DOMException('Recovery database upgrade is blocked by another tab.', 'InvalidStateError'));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException('Recovery transaction was aborted.', 'AbortError'));
    transaction.onerror = () => reject(transaction.error ?? new DOMException('Recovery transaction failed.', 'UnknownError'));
  });
}

function toRecord(snapshot: ProjectVfsSnapshot): RecoveryRecord {
  const files: PersistedFile[] = [...snapshot.files.values()].map(file => {
    const base = { path: file.path, bytes: new Uint8Array(file.bytes) };
    return file.mediaType === undefined ? base : { ...base, mediaType: file.mediaType };
  });
  return {
    projectId: snapshot.projectId,
    format: 'dungeon-scrivener-recovery-snapshot',
    schemaVersion: RECORD_VERSION,
    savedAt: Date.now(),
    directories: [...snapshot.directories],
    files
  };
}

function fromRecord(value: unknown, expectedProjectId: ProjectId): { snapshot: ProjectVfsSnapshot; savedAt: number } {
  if (typeof value !== 'object' || value === null) throw new Error('Recovery record is malformed.');
  const record = value as Partial<RecoveryRecord>;
  if (
    record.format !== 'dungeon-scrivener-recovery-snapshot' ||
    record.schemaVersion !== RECORD_VERSION ||
    record.projectId !== expectedProjectId ||
    !Number.isFinite(record.savedAt) ||
    !Array.isArray(record.directories) ||
    !Array.isArray(record.files)
  ) {
    throw new Error('Recovery record has an unsupported or malformed format.');
  }
  const files: ProjectFile[] = record.files.map(file => {
    if (
      typeof file !== 'object' || file === null || typeof file.path !== 'string' ||
      !(file.bytes instanceof Uint8Array) ||
      (file.mediaType !== undefined && typeof file.mediaType !== 'string')
    ) throw new Error('Recovery file entry is malformed.');
    const base = { path: file.path, bytes: new Uint8Array(file.bytes), role: 'arbitrary' as const };
    return file.mediaType === undefined ? base : { ...base, mediaType: file.mediaType };
  });
  if (record.directories.some(path => typeof path !== 'string')) throw new Error('Recovery directory entry is malformed.');
  return {
    snapshot: createSnapshot(files, record.directories),
    savedAt: record.savedAt as number
  };
}

/** Store a complete VFS snapshot in one IndexedDB transaction. Failed writes leave the prior commit intact. */
export async function saveRecovery(
  snapshot: ProjectVfsSnapshot,
  options: RecoveryOptions = {}
): Promise<RecoveryOperationResult> {
  let database: IDBDatabase | undefined;
  try {
    const record = toRecord(snapshot);
    database = await openDatabase(options);
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const completion = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).put(record);
    await completion;
    return { ok: true };
  } catch (error) {
    return { ok: false, diagnostic: storageDiagnostic(error) };
  } finally {
    database?.close();
  }
}

/** Load the last committed snapshot without rewriting its source bytes. */
export async function loadRecovery(
  projectId: ProjectId,
  options: RecoveryOptions = {}
): Promise<LoadRecoveryResult> {
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(options);
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const completion = transactionDone(transaction);
    const request = transaction.objectStore(STORE_NAME).get(projectId);
    const value = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to read recovery snapshot.'));
    });
    await completion;
    if (value === undefined) return { ok: true, snapshot: null, savedAt: null };
    const restored = fromRecord(value, projectId);
    return { ok: true, snapshot: restored.snapshot, savedAt: restored.savedAt };
  } catch (error) {
    return { ok: false, diagnostic: storageDiagnostic(error) };
  } finally {
    database?.close();
  }
}

/** Remove the project's local recovery snapshot. */
export async function clearRecovery(
  projectId: ProjectId,
  options: RecoveryOptions = {}
): Promise<RecoveryOperationResult> {
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase(options);
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const completion = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).delete(projectId);
    await completion;
    return { ok: true };
  } catch (error) {
    return { ok: false, diagnostic: storageDiagnostic(error) };
  } finally {
    database?.close();
  }
}
