import { readProjectZipCore, VfsError } from './index.js';

self.addEventListener('message', event => {
  const request = event.data as { bytes: Uint8Array; limits?: import('@dungeon-scrivener/model').ArchiveLimits };
  void readProjectZipCore(request.bytes, request.limits, (path, completed) => {
    self.postMessage({ kind: completed ? 'member-complete' : 'member-start', path });
  }).then(snapshot => {
    self.postMessage({ kind: 'success', snapshot });
  }, error => {
    const vfsError = error instanceof VfsError ? error : new VfsError('DS-VFS-OPERATION', error instanceof Error ? error.message : 'Project ZIP import failed.');
    self.postMessage({
      kind: 'failure',
      code: vfsError.code,
      message: vfsError.message,
      ...(vfsError.path === undefined ? {} : { path: vfsError.path })
    });
  });
});
