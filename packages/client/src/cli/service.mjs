// Installing, repairing and removing the background agent: one supervisor per platform, plus the
// write-access tweaks a fresh install needs. Nothing here is reachable from a model or an MCP tool.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { PACKAGE_NAME, VERSION } from '../version.mjs';

import { saveConfig } from './config.mjs';
import { configDir, home, linuxServiceFile, linuxServiceLauncherFile, macLogFile, macServiceFile, macServiceLabel, npm, windowsTaskName } from './env.mjs';
import { output, run } from './shell.mjs';

export function servicePlatform() {
  return process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM ? process.env.REMCP_TEST_PLATFORM : process.platform;
}

export function globalPrefix() {
  return output(npm.command, [...npm.args, 'prefix', '--global']);
}

export function globalCliPath() {
  const prefix = globalPrefix();
  return servicePlatform() === 'win32' ? path.join(prefix, 'remcp.cmd') : path.join(prefix, 'bin', 'remcp');
}

export function npmGlobalInstall(...specs) {
  run(npm.command, [...npm.args, 'install', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
}

export function quoteSystemd(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function resolvedCliScript(cliPath) {
  return fs.existsSync(cliPath) ? fs.realpathSync(cliPath) : path.resolve(cliPath);
}

function writeLinuxServiceLauncher(cliPath = globalCliPath()) {
  const cliScript = resolvedCliScript(cliPath);
  const launcher = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cliScript)} \"$@\"\n`;
  fs.mkdirSync(path.dirname(linuxServiceLauncherFile), { recursive: true, mode: 0o700 });
  const temporary = `${linuxServiceLauncherFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, launcher, { mode: 0o700 });
  fs.chmodSync(temporary, 0o700);
  fs.renameSync(temporary, linuxServiceLauncherFile);
  return linuxServiceLauncherFile;
}

export function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function installLinuxService(cliPath = globalCliPath()) {
  const launcherFile = writeLinuxServiceLauncher(cliPath);
  const unit = `[Unit]\nDescription=ReMCP device agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${quoteSystemd(launcherFile)} start\nRestart=always\nRestartSec=3\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
  fs.mkdirSync(path.dirname(linuxServiceFile), { recursive: true });
  fs.writeFileSync(linuxServiceFile, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', 'remcp-agent.service']);
}

export function macLaunchDomain() {
  if (typeof process.getuid !== 'function') throw new Error('Could not determine the current macOS user');
  return `gui/${process.getuid()}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function macServicePlist(cliPath) {
  // launchd wants an absolute path; a symlinked prefix that npm has not materialised yet (or a path
  // that is about to be replaced by the next install) must not abort the repair — a stale plist is
  // exactly the loop this function exists to break.
  const cliScript = fs.existsSync(cliPath) ? fs.realpathSync(cliPath) : path.resolve(cliPath);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${macServiceLabel}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(cliScript)}</string><string>start</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${xmlEscape(macLogFile)}</string>\n<key>StandardErrorPath</key><string>${xmlEscape(macLogFile)}</string>\n</dict></plist>\n`;
}

function macJobLoaded(target) {
  return spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
}

function submitMacHelper(kind, lines) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const nonce = `${process.pid}.${Date.now()}`;
  const helperFile = path.join(configDir, `launchd-${kind}-${nonce}.sh`);
  const helperLabel = `${macServiceLabel}.${kind}.${nonce}`;
  const script = [
    '#!/bin/sh',
    'sleep 1',
    'status=0',
    ...lines.map(line => `${line} || status=$?`),
    `if [ "$status" -ne 0 ]; then echo "ReMCP launchd ${kind} helper failed with status $status" >> ${shellQuote(macLogFile)}; fi`,
    `rm -f ${shellQuote(helperFile)}`,
    `launchctl remove ${shellQuote(helperLabel)} >/dev/null 2>&1 || true`,
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(helperFile, script, { mode: 0o700 });
  fs.chmodSync(helperFile, 0o700);
  run('launchctl', ['submit', '-l', helperLabel, '--', '/bin/sh', helperFile]);
  return helperLabel;
}

function scheduleMacServiceReload(domain, target) {
  return submitMacHelper('reload', [
    `launchctl bootout ${shellQuote(target)} >/dev/null 2>&1 || true`,
    `launchctl bootstrap ${shellQuote(domain)} ${shellQuote(macServiceFile)}`,
    `launchctl enable ${shellQuote(target)}`,
    `launchctl kickstart -k ${shellQuote(target)}`,
  ]);
}

function scheduleMacServiceRestart(target) {
  return submitMacHelper('restart', [
    `launchctl kickstart -k ${shellQuote(target)}`,
  ]);
}

export function installMacService(cliPath = globalCliPath(), { restart = true } = {}) {
  const domain = macLaunchDomain();
  const target = `${domain}/${macServiceLabel}`;
  const plist = macServicePlist(cliPath);
  let previous = '';
  try { previous = fs.readFileSync(macServiceFile, 'utf8'); } catch {}
  const loaded = macJobLoaded(target);

  fs.mkdirSync(path.dirname(macServiceFile), { recursive: true });
  fs.mkdirSync(path.dirname(macLogFile), { recursive: true });
  fs.writeFileSync(macServiceFile, plist, { mode: 0o600 });

  if (loaded && previous === plist) {
    run('launchctl', ['enable', target]);
    // Never boot out a healthy loaded job just to refresh an in-place npm install. The final
    // kickstart keeps launchd responsible for bringing the replacement agent back.
    if (restart) run('launchctl', ['kickstart', '-k', target]);
    return 'loaded';
  }

  if (loaded) {
    // A changed Node/npm prefix requires launchd to re-read ProgramArguments. A separate transient
    // launchd job survives booting out com.remcp.agent even when the updater was launched by it.
    scheduleMacServiceReload(domain, target);
    return 'reload-scheduled';
  }

  run('launchctl', ['bootstrap', domain, macServiceFile]);
  run('launchctl', ['enable', target]);
  if (restart) run('launchctl', ['kickstart', '-k', target]);
  return 'bootstrapped';
}

export function installWindowsService(cliPath = globalCliPath()) {
  const command = `"${cliPath}" start`;
  run('schtasks.exe', ['/Create', '/TN', windowsTaskName, '/TR', command, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']);
  run('schtasks.exe', ['/Run', '/TN', windowsTaskName]);
}

// `serviceInstalled` was added after background services already existed in the wild. Treat an
// explicit false as the user's opt-out, an explicit true as the current marker, and only infer the
// old intent from an OS service artifact when the marker is absent. This keeps legacy installs
// repairable without resurrecting a service that a newer client explicitly disabled.
export function persistentServiceExpected(config) {
  if (config?.serviceInstalled === false) return false;
  if (config?.serviceInstalled === true) return true;
  const platform = servicePlatform();
  if (platform === 'linux') return fs.existsSync(linuxServiceFile);
  if (platform === 'darwin') return fs.existsSync(macServiceFile);
  if (platform === 'win32') {
    return spawnSync('schtasks.exe', ['/Query', '/TN', windowsTaskName], { stdio: 'ignore' }).status === 0;
  }
  return false;
}

export function configurePostInstallAccess() {
  const platform = servicePlatform();
  try {
    if (platform === 'darwin') configureMacWriteAccess();
    else if (platform === 'win32') configureWindowsWriteAccess();
    else configureLinuxWriteAccess();
  } catch (error) {
    console.error(`Could not configure write access: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function configureMacWriteAccess() {
  const appName = path.basename(process.execPath);
  const terminalApp = path.basename(process.env.SHELL || '/bin/zsh');
  const workspaceDir = path.join(home, 'Library', 'Application Support', 'ReMCP');
  try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch {}
  try { run('chmod', ['-R', '755', workspaceDir]); } catch {}
  try {
    const script = `tell application "System Preferences" to activate\ndelay 1\ntell application "System Events" to click UI element "Privacy" of toolbar 1 of window "Security & Privacy" of process "System Preferences"\ndelay 1\ntell application "System Events" to click row 4 of table 1 of scroll area 1 of window "Privacy" of application process "System Preferences"\ndelay 1\n`;
    spawnSync('osascript', ['-e', script], { stdio: 'ignore' });
  } catch {}
  console.log('Note: For full Desktop/Documents access on macOS, go to System Settings → Privacy & Security → Full Disk Access and add ReMCP or your Terminal app.');
}

export function configureWindowsWriteAccess() {
  try { run('schtasks.exe', ['/Change', '/TN', windowsTaskName, '/RL', 'HIGHEST', '/IT']); } catch {}
  try {
    const workspaceDir = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ReMCP');
    fs.mkdirSync(workspaceDir, { recursive: true });
  } catch {}
  console.log('ReMCP configured with elevated privileges for full write access.');
}

export function configureLinuxWriteAccess() {
  const dirs = [path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) run('chown', [`${os.userInfo().username}:${os.userInfo().gid}`, dir]);
    } catch {}
  }
  try {
    const workspaceDir = path.join(home, '.local', 'share', 'ReMCP');
    fs.mkdirSync(workspaceDir, { recursive: true });
  } catch {}
}

export function installPersistentAgent(config) {
  const platform = servicePlatform();
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Automatic background service installation is not supported on ${platform}`);
  console.log(`Installing ReMCP ${VERSION}…`);
  npmGlobalInstall(`${PACKAGE_NAME}@${VERSION}`, config.runtime.packageSpec);
  const cliPath = globalCliPath();
  if (platform === 'linux') installLinuxService(cliPath);
  else if (platform === 'darwin') installMacService(cliPath);
  else installWindowsService(cliPath);
  configurePostInstallAccess();
  saveConfig({ ...config, serviceInstalled: true });
  console.log('ReMCP is installed as a background service. Future updates: remcp update');
}

// A machine that was installed as a service must still be one after an update: if the job is missing
// (a failed install, a cleaned LaunchAgents directory, a re-imaged user), the next update recreates
// it instead of leaving a hand-over to a process nobody supervises.
export function ensureServiceIfRecorded(config) {
  if (!persistentServiceExpected(config)) return false;
  try {
    const cliPath = globalCliPath();
    const platform = servicePlatform();
    if (platform === 'linux') {
      if (!fs.existsSync(linuxServiceFile)) {
        installLinuxService(cliPath);
      } else {
        // Keep the systemd unit independent of nvm/Hermes/Homebrew prefixes. Only this small launcher
        // changes when npm or Node moves, so every install converges on one supervisor entrypoint.
        const launcherFile = writeLinuxServiceLauncher(cliPath);
        const unit = fs.readFileSync(linuxServiceFile, 'utf8');
        const expected = `ExecStart=${quoteSystemd(launcherFile)} start`;
        if (!unit.includes(expected)) {
          const repaired = /^ExecStart=/m.test(unit) ? unit.replace(/^ExecStart=.*$/m, expected) : '';
          if (!repaired) {
            // A hand-edited unit with no launcher line is replaced wholesale; the stable launcher is
            // still refreshed first so the replacement never points back at a retired Node manager.
            installLinuxService(cliPath);
          } else {
            fs.writeFileSync(linuxServiceFile, repaired);
            run('systemctl', ['--user', 'daemon-reload']);
          }
        }
      }
    } else if (platform === 'darwin') {
      // launchd bakes the interpreter and CLI path into the plist. Repair the file first, but never
      // boot out a loaded agent inline: this updater may itself be a descendant of that LaunchAgent.
      // installMacService either leaves an unchanged loaded job alone, bootstraps an unloaded job, or
      // hands a changed launcher to an independent transient launchd helper.
      installMacService(cliPath, { restart: false });
    } else if (platform === 'win32') installWindowsService(cliPath);
    // Upgrade the legacy inferred state only after the supervisor repair succeeded. A failed repair
    // must not turn a stale artifact into a permanent "managed service" declaration.
    if (config?.serviceInstalled !== true) saveConfig({ ...config, serviceInstalled: true });
    return true;
  } catch (error) {
    console.error(`Could not ensure the background service: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function restartPersistentServiceIfInstalled(config) {
  if (!persistentServiceExpected(config)) return null;
  const platform = servicePlatform();
  if (platform === 'linux' && fs.existsSync(linuxServiceFile)) {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'restart', 'remcp-agent.service']);
    return 'remcp-agent.service';
  }
  if (platform === 'darwin' && fs.existsSync(macServiceFile)) {
    const target = `${macLaunchDomain()}/${macServiceLabel}`;
    if (macJobLoaded(target)) {
      // Never kill a loaded LaunchAgent inline: the caller may itself be a child of that job.
      // A transient helper survives the handoff and performs the restart after this CLI returns.
      scheduleMacServiceRestart(target);
    } else {
      // A plist can survive while launchd has no loaded job (older installs, logout/login cleanup,
      // manual bootout, or a failed previous update). Re-register it directly.
      installMacService(globalCliPath());
    }
    return macServiceLabel;
  }
  if (platform === 'win32') {
    const result = spawnSync('schtasks.exe', ['/Query', '/TN', windowsTaskName], { stdio: 'ignore' });
    if (result.status === 0) {
      run('schtasks.exe', ['/Run', '/TN', windowsTaskName]);
      return windowsTaskName;
    }
  }
  return null;
}

export function uninstallPersistentService() {
  const platform = servicePlatform();
  if (platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'remcp-agent.service'], { stdio: 'inherit' });
    try { fs.unlinkSync(linuxServiceFile); } catch {}
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  } else if (platform === 'darwin') {
    const domain = macLaunchDomain();
    spawnSync('launchctl', ['bootout', domain, macServiceFile], { stdio: 'ignore' });
    try { fs.unlinkSync(macServiceFile); } catch {}
  } else if (platform === 'win32') {
    spawnSync('schtasks.exe', ['/End', '/TN', windowsTaskName], { stdio: 'ignore' });
    spawnSync('schtasks.exe', ['/Delete', '/TN', windowsTaskName, '/F'], { stdio: 'ignore' });
  }
}
