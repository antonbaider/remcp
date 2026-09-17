import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MACOS_PROTECTED_FOLDERS,
  filesystemAccessHint,
  macosPermissionHint,
  probeFilesystemAccess,
  probeMacosFolderAccess,
  probeWritableRoots,
  windowsPermissionHint,
} from '../src/fs-access.mjs';

const errno = code => Object.assign(new Error(`${code}: denied`), { code });

test('the probe reads the macOS protected folders and keeps missing ones out of the way', async () => {
  const seen = [];
  const result = await probeMacosFolderAccess({
    platform: 'darwin',
    home: '/Users/ada',
    list: async target => {
      seen.push(target);
      if (target.endsWith('Downloads')) throw errno('EACCES');
      if (target.endsWith('Mobile Documents')) throw errno('ENOENT');
      return [];
    },
  });
  assert.equal(result.supported, true);
  assert.deepEqual(seen, [
    '/Users/ada/Desktop',
    '/Users/ada/Documents',
    '/Users/ada/Downloads',
    '/Users/ada/Library/Mobile Documents',
  ]);
  assert.deepEqual(result.folders.map(folder => [folder.name, folder.state]), [
    ['Desktop', 'ok'],
    ['Documents', 'ok'],
    ['Downloads', 'denied'],
    ['iCloud Drive', 'missing'],
  ]);
  // Only a denied folder is a problem: iCloud Drive that was never enabled is not one.
  assert.deepEqual(result.denied, ['Downloads']);
  assert.match(result.hint, /System Settings → Privacy & Security → Full Disk Access/);
});

test('other platforms are not asked about TCC at all', async () => {
  const result = await probeMacosFolderAccess({ platform: 'linux', home: '/home/ada', list: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(result, { supported: false, folders: [] });
  assert.deepEqual([...MACOS_PROTECTED_FOLDERS], ['Desktop', 'Documents', 'Downloads']);
});

test('a folder that fails for another reason is reported, and the hint names the exact binary', async () => {
  const result = await probeMacosFolderAccess({
    platform: 'darwin',
    home: '/Users/ada',
    list: async target => {
      if (target.endsWith('Documents')) throw errno('EIO');
      return [];
    },
  });
  assert.equal(result.folders.find(folder => folder.name === 'Documents').state, 'error');
  assert.equal(result.denied, undefined, 'an I/O error is not a permission verdict');
  assert.match(macosPermissionHint('/usr/local/bin/node'), /\/usr\/local\/bin\/node/);
  assert.match(macosPermissionHint('/usr/local/bin/node'), /remcp start/);
});

test('the write probe creates and removes a file in every allowed root', async () => {
  const created = [];
  const removed = [];
  const results = await probeWritableRoots({
    roots: ['/home/ada/projects', '/root/private'],
    pid: 4242,
    create: async target => { created.push(target); if (target.startsWith('/root/')) throw errno('EACCES'); },
    remove: async target => { removed.push(target); },
  });
  assert.deepEqual(created, ['/home/ada/projects/.remcp-write-probe-4242', '/root/private/.remcp-write-probe-4242']);
  assert.deepEqual(removed, ['/home/ada/projects/.remcp-write-probe-4242'], 'the probe cleans up after itself');
  assert.deepEqual(results, [
    { path: '/home/ada/projects', state: 'ok' },
    { path: '/root/private', state: 'denied', code: 'EACCES' },
  ]);
});

test('the cross-platform probe reports the platform fix for a denied root', async () => {
  const linux = await probeFilesystemAccess({
    platform: 'linux',
    home: '/home/ada',
    roots: ['/root/private'],
    create: async () => { throw errno('EACCES'); },
    remove: async () => {},
  });
  assert.deepEqual(linux.denied, ['/root/private']);
  assert.match(linux.hint, /owner and mode/);
  const windows = await probeFilesystemAccess({
    platform: 'win32',
    home: 'C:\\Users\\Ada',
    roots: ['C:\\logs'],
    create: async () => { throw errno('EPERM'); },
    remove: async () => {},
  });
  assert.deepEqual(windows.denied, ['C:\\logs']);
  assert.match(windows.hint, /Controlled folder access/);
  assert.match(windowsPermissionHint('C:\\node.exe'), /C:\\node\.exe/);
  assert.match(filesystemAccessHint('linux'), /chown\/chmod/);
  const clean = await probeFilesystemAccess({ platform: 'linux', roots: ['/srv'], create: async () => {}, remove: async () => {} });
  assert.equal(clean.denied, undefined, 'nothing to explain when every root is writable');
});
