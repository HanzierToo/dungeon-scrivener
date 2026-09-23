import type {
  ArchiveLimits,
  ProjectFile,
  ProjectArchiveEntry,
  ProjectArchiveIndex,
  ProjectId,
  ProjectVfsSnapshot,
  VfsPath
} from '@dungeon-scrivener/model';
import { Inflate, zipSync } from 'fflate';

export const PROJECT_VFS_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxStructuredJsonBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
  maxPathBytes: 1_024,
  maxSegmentBytes: 255
});

const STABLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const INVALID_UTF16 = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export type VfsErrorCode =
  | 'DS-VFS-PATH'
  | 'DS-VFS-COLLISION'
  | 'DS-VFS-LIMIT'
  | 'DS-VFS-NOT-FOUND'
  | 'DS-VFS-RECOVERY-ID'
  | 'DS-VFS-TIMEOUT'
  | 'DS-VFS-OPERATION';

export class VfsError extends Error {
  readonly code: VfsErrorCode;
  readonly path?: VfsPath;

  constructor(code: VfsErrorCode, message: string, path?: VfsPath) {
    super(message);
    this.name = 'VfsError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

/** Validate a project path and return its comparison-only normalized key. */
export function pathComparisonKey(path: VfsPath): string {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes(':')) {
    throw new VfsError('DS-VFS-PATH', 'Path must be a non-empty relative slash-separated path.', String(path));
  }
  if (INVALID_UTF16.test(path)) {
    throw new VfsError('DS-VFS-PATH', 'Path contains invalid Unicode.', path);
  }
  if (path !== path.normalize('NFC')) {
    throw new VfsError('DS-VFS-PATH', 'Path must already be Unicode NFC normalized.', path);
  }
  let pathBytes: number;
  try {
    pathBytes = new TextEncoder().encode(path).byteLength;
  } catch {
    throw new VfsError('DS-VFS-PATH', 'Path contains invalid Unicode.', path);
  }
  if (pathBytes > PROJECT_VFS_LIMITS.maxPathBytes || CONTROL.test(path)) {
    throw new VfsError('DS-VFS-PATH', 'Path exceeds its byte limit or contains control characters.', path);
  }

  const segments = path.split('/');
  for (const segment of segments) {
    const segmentBytes = new TextEncoder().encode(segment).byteLength;
    if (
      segment.length === 0 || segment === '.' || segment === '..' ||
      segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_DEVICE_NAME.test(segment) ||
      segmentBytes > PROJECT_VFS_LIMITS.maxSegmentBytes
    ) {
      throw new VfsError('DS-VFS-PATH', 'Path contains an unsafe or overlong segment.', path);
    }
  }
  return path.normalize('NFC').toLowerCase();
}

function roleForPath(path: string): ProjectFile['role'] {
  if (path === 'project.json') return 'manifest';
  if (path === 'world.json') return 'world';
  if (/^locales\/[^/]+\.json$/u.test(path)) return 'locale';
  if (path.startsWith('scripts/')) return 'script';
  if (/^assets\/sha256\/[a-f0-9]{64}$/u.test(path)) return 'asset';
  return 'arbitrary';
}

function recoveryProjectId(): ProjectId {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi === undefined || typeof cryptoApi.getRandomValues !== 'function') {
    throw new VfsError('DS-VFS-RECOVERY-ID', 'Cryptographic randomness is required to create a recovery project ID.');
  }
  try {
    const random = cryptoApi.getRandomValues(new Uint8Array(16));
    return `recovery-${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    throw new VfsError('DS-VFS-RECOVERY-ID', 'Unable to create a cryptographically random recovery project ID.');
  }
}

function projectIdFromManifest(file: ProjectFile | undefined): ProjectId | undefined {
  if (file === undefined) return undefined;
  try {
    const manifest: unknown = JSON.parse(textDecoder.decode(file.bytes));
    if (typeof manifest !== 'object' || manifest === null || !('projectId' in manifest)) return undefined;
    const projectId = manifest.projectId;
    return typeof projectId === 'string' && projectId.length <= 64 && STABLE_ID.test(projectId)
      ? projectId
      : undefined;
  } catch {
    return undefined;
  }
}

function cloneFile(file: ProjectFile): ProjectFile {
  const bytes = new Uint8Array(file.bytes);
  return file.mediaType === undefined
    ? { path: file.path, bytes, role: file.role }
    : { path: file.path, bytes, role: file.role, mediaType: file.mediaType };
}

/** Build a validated immutable snapshot without rewriting any supplied file bytes. */
export function createSnapshot(
  files: Iterable<ProjectFile>,
  directories: Iterable<VfsPath> = []
): ProjectVfsSnapshot {
  const byKey = new Map<string, ProjectFile>();
  const directoryByKey = new Map<string, VfsPath>();
  let totalBytes = 0;

  for (const path of directories) {
    const key = pathComparisonKey(path);
    if (directoryByKey.has(key) || byKey.has(key)) {
      throw new VfsError('DS-VFS-COLLISION', 'Two project paths have the same case-insensitive comparison key.', path);
    }
    directoryByKey.set(key, path);
    if (directoryByKey.size > PROJECT_VFS_LIMITS.maxEntries) {
      throw new VfsError('DS-VFS-LIMIT', 'Project exceeds the 20,000 entry limit.', path);
    }
  }

  for (const input of files) {
    const key = pathComparisonKey(input.path);
    if (byKey.has(key) || directoryByKey.has(key)) {
      throw new VfsError('DS-VFS-COLLISION', 'Two project paths have the same case-insensitive comparison key.', input.path);
    }
    if (!(input.bytes instanceof Uint8Array)) {
      throw new VfsError('DS-VFS-OPERATION', 'File contents must be Uint8Array bytes.', input.path);
    }
    if (input.bytes.byteLength > PROJECT_VFS_LIMITS.maxFileBytes) {
      throw new VfsError('DS-VFS-LIMIT', 'File exceeds the 64 MiB project file limit.', input.path);
    }
    if ((input.path === 'project.json' || input.path === 'world.json' || /^locales\/[^/]+\.json$/u.test(input.path)) && input.bytes.byteLength > PROJECT_VFS_LIMITS.maxStructuredJsonBytes) {
      throw new VfsError('DS-VFS-LIMIT', 'Structured JSON file exceeds the 16 MiB limit.', input.path);
    }
    totalBytes += input.bytes.byteLength;
    if (totalBytes > PROJECT_VFS_LIMITS.maxTotalBytes) {
      throw new VfsError('DS-VFS-LIMIT', 'Project files exceed the 256 MiB total limit.', input.path);
    }
    if (byKey.size + directoryByKey.size >= PROJECT_VFS_LIMITS.maxEntries) {
      throw new VfsError('DS-VFS-LIMIT', 'Project exceeds the 20,000 entry limit.', input.path);
    }
    const file = cloneFile({ ...input, role: roleForPath(input.path) });
    byKey.set(key, file);
  }

  const fileKeys = [...byKey.keys()];
  for (const key of fileKeys) {
    const segments = key.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = segments.slice(0, length).join('/');
      if (byKey.has(ancestor)) {
        throw new VfsError('DS-VFS-COLLISION', 'A file cannot also be used as a parent directory.', byKey.get(ancestor)?.path);
      }
    }
  }
  for (const [key, path] of directoryByKey) {
    const segments = key.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = segments.slice(0, length).join('/');
      if (byKey.has(ancestor)) {
        throw new VfsError('DS-VFS-COLLISION', 'A file cannot also be used as a parent directory.', byKey.get(ancestor)?.path ?? path);
      }
    }
  }

  const manifest = [...byKey.values()].find(file => file.path === 'project.json');
  const projectId = projectIdFromManifest(manifest) ?? recoveryProjectId();
  const fileMap = new Map<VfsPath, ProjectFile>();
  for (const file of byKey.values()) fileMap.set(file.path, file);
  return Object.freeze({
    format: 'dungeon-scrivener-project-vfs-index',
    schemaVersion: 1,
    projectId,
    directories: new Set(directoryByKey.values()),
    files: fileMap
  });
}

function snapshotInputs(snapshot: ProjectVfsSnapshot): { files: ProjectFile[]; directories: VfsPath[] } {
  return {
    files: [...snapshot.files.values()],
    directories: [...snapshot.directories]
  };
}

export function readProjectFile(snapshot: ProjectVfsSnapshot, path: VfsPath): ProjectFile | undefined {
  const key = pathComparisonKey(path);
  for (const file of snapshot.files.values()) {
    if (pathComparisonKey(file.path) === key) return cloneFile(file);
  }
  return undefined;
}

export function addProjectFile(snapshot: ProjectVfsSnapshot, file: ProjectFile): ProjectVfsSnapshot {
  const key = pathComparisonKey(file.path);
  if ([...snapshot.files.values(), ...snapshot.directories].some(entry => pathComparisonKey(typeof entry === 'string' ? entry : entry.path) === key)) {
    throw new VfsError('DS-VFS-COLLISION', 'A file or directory already uses this path.', file.path);
  }
  const { files, directories } = snapshotInputs(snapshot);
  files.push(file);
  return createSnapshot(files, directories);
}

export function addProjectDirectory(snapshot: ProjectVfsSnapshot, path: VfsPath): ProjectVfsSnapshot {
  const key = pathComparisonKey(path);
  if ([...snapshot.files.values(), ...snapshot.directories].some(entry => pathComparisonKey(typeof entry === 'string' ? entry : entry.path) === key)) {
    throw new VfsError('DS-VFS-COLLISION', 'A file or directory already uses this path.', path);
  }
  const { files, directories } = snapshotInputs(snapshot);
  directories.push(path);
  return createSnapshot(files, directories);
}

export function renameProjectPath(snapshot: ProjectVfsSnapshot, from: VfsPath, to: VfsPath): ProjectVfsSnapshot {
  const fromKey = pathComparisonKey(from);
  const toKey = pathComparisonKey(to);
  const sourceFile = [...snapshot.files.values()].find(file => pathComparisonKey(file.path) === fromKey);
  const sourceDirectoryExists = [...snapshot.directories].some(path => pathComparisonKey(path) === fromKey);
  const sourcePrefix = `${fromKey}/`;
  const hasDescendants = [...snapshot.files.values()].some(file => pathComparisonKey(file.path).startsWith(sourcePrefix)) ||
    [...snapshot.directories].some(path => pathComparisonKey(path).startsWith(sourcePrefix));
  if (sourceFile === undefined && !sourceDirectoryExists && !hasDescendants) throw new VfsError('DS-VFS-NOT-FOUND', 'Rename source does not exist.', from);
  if (toKey === fromKey || toKey.startsWith(sourcePrefix) || fromKey.startsWith(`${toKey}/`)) {
    throw new VfsError('DS-VFS-OPERATION', 'Rename destination overlaps its source.', to);
  }
  if ([...snapshot.files.values(), ...snapshot.directories].some(entry => {
    const entryPath = typeof entry === 'string' ? entry : entry.path;
    const entryKey = pathComparisonKey(entryPath);
    return entryKey === toKey || (sourceDirectoryExists || hasDescendants) && entryKey.startsWith(`${toKey}/`);
  })) {
    throw new VfsError('DS-VFS-COLLISION', 'Rename destination already exists.', to);
  }
  const { files, directories } = snapshotInputs(snapshot);
  const sourceSegmentCount = from.split('/').length;
  const renamedPath = (path: string): string => {
    const pathKey = pathComparisonKey(path);
    if (pathKey === fromKey) return to;
    const suffix = path.split('/').slice(sourceSegmentCount).join('/');
    return `${to}/${suffix}`;
  };
  const renamedFiles = files.map(file => {
    const pathKey = pathComparisonKey(file.path);
    return pathKey === fromKey || (sourceDirectoryExists || hasDescendants) && pathKey.startsWith(sourcePrefix)
      ? { ...file, path: renamedPath(file.path) }
      : file;
  });
  const renamedDirectories = directories.map(path => {
    const pathKey = pathComparisonKey(path);
    return pathKey === fromKey || pathKey.startsWith(sourcePrefix) ? renamedPath(path) : path;
  });
  return createSnapshot(renamedFiles, renamedDirectories);
}

export function deleteProjectPath(snapshot: ProjectVfsSnapshot, path: VfsPath): ProjectVfsSnapshot {
  const key = pathComparisonKey(path);
  const { files, directories } = snapshotInputs(snapshot);
  const prefix = `${key}/`;
  const nextFiles = files.filter(file => {
    const fileKey = pathComparisonKey(file.path);
    return fileKey !== key && !fileKey.startsWith(prefix);
  });
  const nextDirectories = directories.filter(entry => {
    const directoryKey = pathComparisonKey(entry);
    return directoryKey !== key && !directoryKey.startsWith(prefix);
  });
  if (nextFiles.length === files.length && nextDirectories.length === directories.length) {
    throw new VfsError('DS-VFS-NOT-FOUND', 'Delete target does not exist.', path);
  }
  return createSnapshot(nextFiles, nextDirectories);
}

/** Hash bytes only for content-addressed managed assets. */
export async function hashManagedAsset(bytes: Uint8Array): Promise<`sha256:${string}`> {
  if (bytes.byteLength > PROJECT_VFS_LIMITS.maxFileBytes) {
    throw new VfsError('DS-VFS-LIMIT', 'Managed asset exceeds the 64 MiB project file limit.');
  }
  if (globalThis.crypto?.subtle === undefined) {
    throw new VfsError('DS-VFS-OPERATION', 'SHA-256 hashing is unavailable in this runtime.');
  }
  const safeBytes = new Uint8Array(bytes.byteLength);
  safeBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', safeBytes.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

const PROJECT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxEntries: 20_000,
  maxPathBytes: 1_024
});
const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const DATA_DESCRIPTOR = 0x08074b50;

interface ParsedZipEntry {
  readonly path: string;
  readonly directory: boolean;
  readonly compression: 'store' | 'deflate';
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly dataStart: number;
  readonly localEnd: number;
  readonly localOffset: number;
}

function failZip(message: string, path?: string): never {
  throw new VfsError('DS-VFS-OPERATION', message, path);
}

function effectiveArchiveLimits(limits: ArchiveLimits = PROJECT_ARCHIVE_LIMITS): ArchiveLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new VfsError('DS-VFS-OPERATION', `Archive limit ${name} must be a non-negative safe integer.`);
    }
  }
  return {
    maxArchiveBytes: Math.min(limits.maxArchiveBytes, PROJECT_ARCHIVE_LIMITS.maxArchiveBytes),
    maxExpandedBytes: Math.min(limits.maxExpandedBytes, PROJECT_ARCHIVE_LIMITS.maxExpandedBytes),
    maxEntryBytes: Math.min(limits.maxEntryBytes, PROJECT_ARCHIVE_LIMITS.maxEntryBytes),
    maxEntries: Math.min(limits.maxEntries, PROJECT_ARCHIVE_LIMITS.maxEntries),
    maxPathBytes: Math.min(limits.maxPathBytes, PROJECT_ARCHIVE_LIMITS.maxPathBytes)
  };
}

function u16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) failZip('ZIP structure is truncated.');
  return bytes[offset]! | bytes[offset + 1]! << 8;
}

function u32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) failZip('ZIP structure is truncated.');
  return (bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16 | bytes[offset + 3]! << 24) >>> 0;
}

function decodeZipPath(bytes: Uint8Array, flags: number): string {
  if ((flags & 0x0800) === 0 && bytes.some(byte => byte > 0x7f)) {
    failZip('ZIP member names with non-ASCII bytes must use the UTF-8 flag.');
  }
  try {
    return textDecoder.decode(bytes);
  } catch {
    failZip('ZIP member name is not valid UTF-8.');
  }
}

function validateExtraFields(bytes: Uint8Array, start: number, length: number): void {
  const end = start + length;
  if (end > bytes.byteLength) failZip('ZIP extra-field data is truncated.');
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) failZip('ZIP extra-field header is truncated.');
    const id = u16(bytes, offset);
    const fieldLength = u16(bytes, offset + 2);
    offset += 4;
    if (offset + fieldLength > end) failZip('ZIP extra-field data is truncated.');
    if (id === 0x0001) failZip('Zip64 archives are not supported.');
    offset += fieldLength;
  }
}

function parseProjectZip(bytes: Uint8Array, limits: ArchiveLimits): ParsedZipEntry[] {
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new VfsError('DS-VFS-LIMIT', 'Project ZIP exceeds the 128 MiB input limit.');
  }
  const minEnd = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minEnd; offset -= 1) {
    if (u32(bytes, offset) === END_OF_CENTRAL_DIRECTORY) {
      const commentLength = u16(bytes, offset + 20);
      if (offset + 22 + commentLength === bytes.byteLength) {
        endOffset = offset;
        break;
      }
    }
  }
  if (endOffset < 0) failZip('ZIP end-of-directory record is missing or malformed.');
  if (endOffset >= 20 && (u32(bytes, endOffset - 20) === ZIP64_LOCATOR || u32(bytes, endOffset - 4) === ZIP64_END_OF_CENTRAL_DIRECTORY)) {
    failZip('Zip64 archives are not supported.');
  }

  const diskNumber = u16(bytes, endOffset + 4);
  const centralDisk = u16(bytes, endOffset + 6);
  const entriesOnDisk = u16(bytes, endOffset + 8);
  const entryCount = u16(bytes, endOffset + 10);
  const centralSize = u32(bytes, endOffset + 12);
  const centralOffset = u32(bytes, endOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    failZip('Split or multi-volume ZIP archives are not supported.');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    failZip('Zip64 archives are not supported.');
  }
  if (entryCount > limits.maxEntries) throw new VfsError('DS-VFS-LIMIT', 'Project ZIP exceeds the 20,000 entry limit.');
  if (centralOffset + centralSize !== endOffset || centralOffset > bytes.byteLength) {
    failZip('ZIP central directory bounds are invalid.');
  }

  const entries: ParsedZipEntry[] = [];
  let cursor = centralOffset;
  let expandedTotal = 0;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index += 1) {
    const centralHeaderOffset = cursor;
    if (u32(bytes, cursor) !== CENTRAL_FILE_HEADER) failZip('ZIP central directory entry is malformed.');
    const madeBy = u16(bytes, cursor + 4);
    const neededVersion = u16(bytes, cursor + 6);
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const crc32 = u32(bytes, cursor + 16);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const memberCommentLength = u16(bytes, cursor + 32);
    const diskStart = u16(bytes, cursor + 34);
    const externalAttributes = u32(bytes, cursor + 38);
    const localOffset = u32(bytes, cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + memberCommentLength;
    if (next > centralOffset + centralSize) failZip('ZIP central directory entry is truncated.');
    const pathRaw = decodeZipPath(bytes.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    validateExtraFields(bytes, cursor + 46 + nameLength, extraLength);
    cursor = next;

    if (diskStart !== 0 || neededVersion > 20) failZip('ZIP member requires an unsupported feature.', pathRaw);
    if ((flags & ~0x080e) !== 0 || (flags & 0x0001) !== 0) failZip('Encrypted or unsupported ZIP member flags are not supported.', pathRaw);
    if (method !== 0 && method !== 8) failZip('Unsupported ZIP compression method.', pathRaw);
    if (method === 0 && (flags & 0x0006) !== 0) failZip('Invalid deflate flags on a stored ZIP member.', pathRaw);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) failZip('Zip64 archives are not supported.', pathRaw);
    if (uncompressedSize > limits.maxEntryBytes) throw new VfsError('DS-VFS-LIMIT', 'ZIP member exceeds its configured expanded size limit.', pathRaw);
    expandedTotal += uncompressedSize;
    if (expandedTotal > limits.maxExpandedBytes) throw new VfsError('DS-VFS-LIMIT', 'Project ZIP exceeds its configured total expanded size limit.', pathRaw);

    const directory = pathRaw.endsWith('/');
    const path = directory ? pathRaw.slice(0, -1) : pathRaw;
    const pathBytes = new TextEncoder().encode(path).byteLength;
    if (pathBytes > limits.maxPathBytes) throw new VfsError('DS-VFS-LIMIT', 'ZIP member path exceeds the 1,024 byte limit.', path);
    const key = pathComparisonKey(path);
    assertReservedPathCasing(path);
    if (names.has(key)) throw new VfsError('DS-VFS-COLLISION', 'ZIP contains duplicate or case-colliding paths.', path);
    names.add(key);
    if (directory && uncompressedSize !== 0) failZip('ZIP directory entries must not contain file data.', path);

    const host = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0xf000;
    if (host === 3 && unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) {
      failZip('ZIP symlinks and special files are not supported.', path);
    }
    if ((externalAttributes & 0x08) !== 0) failZip('ZIP volume labels are not supported.', path);

    if (localOffset + 30 > centralOffset || u32(bytes, localOffset) !== LOCAL_FILE_HEADER) failZip('ZIP local file header is malformed.', path);
    const localFlags = u16(bytes, localOffset + 6);
    const localMethod = u16(bytes, localOffset + 8);
    const localCrc = u32(bytes, localOffset + 14);
    const localCompressed = u32(bytes, localOffset + 18);
    const localUncompressed = u32(bytes, localOffset + 22);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > centralOffset || dataEnd > centralOffset) failZip('ZIP member data exceeds archive bounds.', path);
    if (localMethod !== method || localFlags !== flags) failZip('ZIP local and central headers disagree.', path);
    const centralNameStart = centralHeaderOffset + 46;
    if (localNameLength !== nameLength || !bytes.subarray(localNameStart, localNameStart + localNameLength).every((byte, localIndex) => byte === bytes[centralNameStart + localIndex])) {
      failZip('ZIP local and central member names disagree.', path);
    }
    if ((flags & 0x0008) === 0 && (localCrc !== crc32 || localCompressed !== compressedSize || localUncompressed !== uncompressedSize)) {
      failZip('ZIP local and central sizes or CRC disagree.', path);
    }
    validateExtraFields(bytes, localNameStart + localNameLength, localExtraLength);
    if ((flags & 0x0008) !== 0) {
      let descriptorOffset = dataEnd;
      if (u32(bytes, descriptorOffset) === DATA_DESCRIPTOR) descriptorOffset += 4;
      if (descriptorOffset + 12 > centralOffset || u32(bytes, descriptorOffset) !== crc32 || u32(bytes, descriptorOffset + 4) !== compressedSize || u32(bytes, descriptorOffset + 8) !== uncompressedSize) {
        failZip('ZIP data descriptor does not match its central directory entry.', path);
      }
    }
    entries.push({
      path,
      directory,
      compression: method === 0 ? 'store' : 'deflate',
      flags,
      crc32,
      compressedSize,
      uncompressedSize,
      dataStart,
      localEnd: dataEnd,
      localOffset
    });
  }
  if (cursor !== centralOffset + centralSize) failZip('ZIP central directory has trailing or missing entry data.');
  const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]!.localEnd > sorted[index]!.localOffset) failZip('ZIP local entries overlap.');
  }
  return entries;
}

function assertReservedPathCasing(path: string): void {
  const lower = path.toLowerCase();
  if ((lower === 'project.json' && path !== 'project.json') || (lower === 'world.json' && path !== 'world.json')) {
    throw new VfsError('DS-VFS-PATH', 'Reserved project file paths must use their exact lowercase spelling.', path);
  }
  if (lower.startsWith('locales/') && !path.startsWith('locales/')) {
    throw new VfsError('DS-VFS-PATH', 'Reserved locale paths must use the exact lowercase locales/ prefix.', path);
  }
  if (lower.startsWith('scripts/') && !path.startsWith('scripts/')) {
    throw new VfsError('DS-VFS-PATH', 'Reserved script paths must use the exact lowercase scripts/ prefix.', path);
  }
  if (lower.startsWith('assets/sha256/') && !path.startsWith('assets/sha256/')) {
    throw new VfsError('DS-VFS-PATH', 'Managed asset paths must use the exact assets/sha256/ prefix.', path);
  }
  if (/^assets\/sha256\/[a-f0-9]{64}$/iu.test(path) && !/^assets\/sha256\/[a-f0-9]{64}$/u.test(path)) {
    throw new VfsError('DS-VFS-PATH', 'Managed asset digests must use lowercase hexadecimal.', path);
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) failZip('SHA-256 hashing is unavailable in this runtime.');
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function inflateBounded(compressed: Uint8Array, declaredSize: number, path: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  let inflationError: Error | undefined;
  const inflater = new Inflate();
  inflater.ondata = chunk => {
    length += chunk.byteLength;
    if (length > declaredSize || length > PROJECT_ARCHIVE_LIMITS.maxEntryBytes) {
      inflationError = new VfsError('DS-VFS-LIMIT', 'Actual ZIP expansion exceeds the declared or allowed member size.', path);
      throw inflationError;
    }
    chunks.push(chunk);
  };
  try {
    inflater.push(compressed, true);
  } catch (error) {
    if (inflationError !== undefined) throw inflationError;
    throw new VfsError('DS-VFS-OPERATION', `Could not inflate ZIP member: ${error instanceof Error ? error.message : 'invalid deflate stream'}`, path);
  }
  if (length !== declaredSize) failZip('ZIP expanded size does not match its central directory declaration.', path);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/** Parse and safely copy a project archive. Project content remains inert. */
export async function readProjectZipCore(
  bytes: Uint8Array,
  requestedLimits?: ArchiveLimits,
  onMemberProgress?: (path: string, completed: boolean) => void
): Promise<ProjectVfsSnapshot> {
  const limits = effectiveArchiveLimits(requestedLimits);
  const parsed = parseProjectZip(bytes, limits);
  const files: ProjectFile[] = [];
  const directories: string[] = [];
  const indexEntries: ProjectArchiveEntry[] = [];
  let actualExpandedTotal = 0;

  for (const entry of parsed) {
    onMemberProgress?.(entry.path, false);
    if (entry.directory) {
      directories.push(entry.path);
      indexEntries.push({ kind: 'directory', path: entry.path });
      onMemberProgress?.(entry.path, true);
      continue;
    }
    const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let contents: Uint8Array;
    if (entry.compression === 'store') {
      if (entry.compressedSize !== entry.uncompressedSize) failZip('Stored ZIP member has inconsistent compressed and expanded sizes.', entry.path);
      contents = new Uint8Array(compressed);
    } else {
      contents = inflateBounded(compressed, entry.uncompressedSize, entry.path);
    }
    if (contents.byteLength !== entry.uncompressedSize) failZip('ZIP expanded size does not match its central directory declaration.', entry.path);
    if (crc32(contents) !== entry.crc32) failZip('ZIP member CRC-32 check failed.', entry.path);
    actualExpandedTotal += contents.byteLength;
    if (actualExpandedTotal > limits.maxExpandedBytes) throw new VfsError('DS-VFS-LIMIT', 'Project ZIP actual expansion exceeds the 256 MiB limit.', entry.path);
    const digest = await sha256Hex(contents);
    files.push({ path: entry.path, bytes: contents, role: roleForPath(entry.path) });
    indexEntries.push({
      kind: 'file',
      compression: entry.compression,
      path: entry.path,
      compressedSize: entry.compressedSize,
      uncompressedSize: contents.byteLength,
      crc32: hex32(crc32(contents)),
      sha256: digest
    });
    onMemberProgress?.(entry.path, true);
  }
  const snapshot = createSnapshot(files, directories);
  // The archive index is contract metadata, not a member in the project ZIP.
  const archiveIndex: ProjectArchiveIndex = {
    format: 'dungeon-scrivener-project-archive-index',
    schemaVersion: 1,
    archiveVersion: 1,
    entries: indexEntries
  };
  void archiveIndex;
  return snapshot;
}

interface ZipWorkerResponse {
  readonly kind: 'success';
  readonly snapshot: ProjectVfsSnapshot;
}

interface ZipWorkerFailure {
  readonly kind: 'failure';
  readonly code: VfsErrorCode;
  readonly message: string;
  readonly path?: string;
}

interface ZipWorkerProgress {
  readonly kind: 'member-start' | 'member-complete';
  readonly path: string;
}

/** Use a module worker in browsers so archive parsing and inflation cannot block editing. */
export function readProjectZip(bytes: Uint8Array, requestedLimits?: ArchiveLimits): Promise<ProjectVfsSnapshot> {
  if (typeof Worker === 'undefined' || typeof document === 'undefined') {
    return readProjectZipCore(bytes, requestedLimits);
  }

  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./zip-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      void readProjectZipCore(bytes, requestedLimits).then(resolve, reject);
      return;
    }

    let finished = false;
    let memberTimer: ReturnType<typeof setTimeout> | undefined;
    const importTimer = setTimeout(() => {
      finish(new VfsError('DS-VFS-TIMEOUT', 'Project ZIP import exceeded the 30 second limit.'));
    }, 30_000);
    const clearMemberTimer = (): void => {
      if (memberTimer !== undefined) clearTimeout(memberTimer);
      memberTimer = undefined;
    };
    const finish = (error?: Error, snapshot?: ProjectVfsSnapshot): void => {
      if (finished) return;
      finished = true;
      clearTimeout(importTimer);
      clearMemberTimer();
      worker.terminate();
      if (error !== undefined) reject(error);
      else if (snapshot !== undefined) resolve(snapshot);
      else reject(new VfsError('DS-VFS-OPERATION', 'Project ZIP worker returned no snapshot.'));
    };

    worker.addEventListener('message', event => {
      const message = event.data as ZipWorkerResponse | ZipWorkerFailure | ZipWorkerProgress;
      if (message.kind === 'member-start') {
        clearMemberTimer();
        memberTimer = setTimeout(() => {
          finish(new VfsError('DS-VFS-TIMEOUT', 'ZIP member import exceeded the 5 second limit.', message.path));
        }, 5_000);
      } else if (message.kind === 'member-complete') {
        clearMemberTimer();
      } else if (message.kind === 'failure') {
        finish(new VfsError(message.code, message.message, message.path));
      } else if (message.kind === 'success') {
        finish(undefined, message.snapshot);
      }
    });
    worker.addEventListener('error', event => {
      finish(new VfsError('DS-VFS-OPERATION', `Project ZIP worker failed: ${event.message}`));
    });

    try {
      const transferableBytes = new Uint8Array(bytes);
      worker.postMessage({ bytes: transferableBytes, limits: requestedLimits }, [transferableBytes.buffer]);
    } catch (error) {
      finish(new VfsError('DS-VFS-OPERATION', `Could not start project ZIP worker: ${error instanceof Error ? error.message : 'transfer failed'}`));
    }
  });
}

/** Write project file bytes and explicit empty directories into a project ZIP. */
export async function writeProjectZip(snapshot: ProjectVfsSnapshot): Promise<Uint8Array> {
  const input: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const file of snapshot.files.values()) {
    pathComparisonKey(file.path);
    input[file.path] = new Uint8Array(file.bytes);
  }
  for (const directory of snapshot.directories) {
    pathComparisonKey(directory);
    if (input[`${directory}/`] !== undefined) continue;
    input[`${directory}/`] = new Uint8Array();
  }
  try {
    return zipSync(input, { level: 6, mtime: new Date(1980, 0, 1) });
  } catch (error) {
    throw new VfsError('DS-VFS-OPERATION', `Could not create project ZIP: ${error instanceof Error ? error.message : 'unsupported archive content'}`);
  }
}
