import os from 'node:os';
import path from 'node:path';
import { readdir, rm, writeFile } from 'node:fs/promises';

// macOS gates Desktop, Documents, Downloads and iCloud Drive behind TCC. A paired Mac can be online,
// healthy and answering tools, and still fail every write into Desktop with `EACCES: permission
// denied` — the failure people actually report, because the workspace and the model only ever see the
// errno. `remcp doctor` is the one place that can look at the machine itself, so it reports which of
// those folders this process may use.
//
// The probe is read-only on purpose: reading a directory is what TCC gates, so a directory that
// cannot be listed is a directory that cannot be written either, and listing one cannot change it.
export const MACOS_PROTECTED_FOLDERS = Object.freeze(['Desktop', 'Documents', 'Downloads']);

export function macosPermissionHint(execPath = process.execPath) {
  return `macOS is blocking one or more protected folders. Grant access by hand: System Settings → Privacy & Security → Full Disk Access → + → ${execPath}, then restart the agent with \`remcp start\`. Folders outside Desktop, Documents, Downloads and iCloud Drive need no new permission.`;
}

export function windowsPermissionHint(execPath = process.execPath) {
  return `Windows is refusing the write. Allow it under Windows Security → Virus & threat protection → Ransomware protection → Allow an app through Controlled folder access (${execPath}), check the read-only attribute of the file, and restart the agent with \`remcp start\`.`;
}

export function linuxPermissionHint() {
  return 'The write was denied by the file system. Check the owner and mode of the folder and its parents (chown/chmod), or choose a path this user owns; folders under /root or another account need root, which ReMCP deliberately does not use.';
}

export function filesystemAccessHint(platform = process.platform, execPath = process.execPath) {
  if (platform === 'darwin') return macosPermissionHint(execPath);
  if (platform === 'win32') return windowsPermissionHint(execPath);
  return linuxPermissionHint();
}

// Can this process actually write where the runtime is allowed to work? The macOS folders above are
// one answer; this is the other one, and it is the same question on every platform. A temporary file
// is created and removed again, which is the only honest test — `access(W_OK)` reports what the
// permission bits say, not what the sandbox, TCC or Controlled folder access will allow.
export async function probeWritableRoots({ roots = [], create = writeFile, remove = rm, pid = process.pid } = {}) {
  const results = [];
  for (const root of roots) {
    const probe = path.join(String(root), `.remcp-write-probe-${pid}`);
    try {
      await create(probe, '');
      await remove(probe, { force: true });
      results.push({ path: String(root), state: 'ok' });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'unknown';
      results.push({ path: String(root), state: code === 'ENOENT' ? 'missing' : 'denied', code });
    }
  }
  return results;
}

// One shape for `remcp doctor` on every platform: which places the tools may write to, and what to do
// when one of them says no.
export async function probeFilesystemAccess({ platform = process.platform, home = os.homedir(), roots = [], ...probeOptions } = {}) {
  const folders = platform === 'darwin' ? (await probeMacosFolderAccess({ platform, home, ...probeOptions })).folders : [];
  const writable = await probeWritableRoots({ roots: [...new Set(roots.filter(Boolean))], ...probeOptions });
  const denied = [...folders.filter(folder => folder.state === 'denied').map(folder => folder.name), ...writable.filter(root => root.state === 'denied').map(root => root.path)];
  const missing = platform === 'darwin' ? folders.filter(folder => folder.state === 'missing').map(folder => folder.name) : [];
  return {
    platform,
    folders,
    roots: writable,
    ...(denied.length ? { denied, hint: filesystemAccessHint(platform) } : {}),
    ...(missing.length ? { missing } : {}),
  };
}

export async function probeMacosFolderAccess({ platform = process.platform, home = os.homedir(), list = readdir } = {}) {
  if (platform !== 'darwin' || !home) return { supported: false, folders: [] };
  const candidates = MACOS_PROTECTED_FOLDERS.map(name => ({ name, path: path.join(home, name) }));
  // iCloud Drive only exists when it is switched on; a missing folder is not a permission problem.
  candidates.push({ name: 'iCloud Drive', path: path.join(home, 'Library', 'Mobile Documents') });
  const folders = [];
  for (const candidate of candidates) {
    try {
      await list(candidate.path);
      folders.push({ ...candidate, state: 'ok' });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : '';
      if (code === 'ENOENT') folders.push({ ...candidate, state: 'missing' });
      else if (code === 'EACCES' || code === 'EPERM') folders.push({ ...candidate, state: 'denied', code });
      else folders.push({ ...candidate, state: 'error', code: code || 'unknown' });
    }
  }
  const denied = folders.filter(folder => folder.state === 'denied');
  return { supported: true, folders, ...(denied.length ? { denied: denied.map(folder => folder.name), hint: macosPermissionHint() } : {}) };
}
