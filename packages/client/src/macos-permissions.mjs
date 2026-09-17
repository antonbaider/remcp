import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';

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
