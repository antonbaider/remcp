import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { localRuntimeEntry, runAgent, supervisorRestart } from './agent.mjs';
import { npmVersion, resolveNpm } from './npm.mjs';
import { isRuntimeSpecFor, normalizeRuntime } from './runtime.mjs';
import { PACKAGE_NAME, VERSION } from './version.mjs';
import { probeFilesystemAccess } from './fs-access.mjs';

const home = os.homedir();
const configDir = process.env.REMCP_CONFIG_DIR || path.join(home, '.config', 'remcp');
const configFile = path.join(configDir, 'config.json');
const runtimeConfigFile = path.join(configDir, 'runtime.json');
const machineIdFile = path.join(configDir, 'machine-id');
const linuxServiceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
const macServiceLabel = 'com.remcp.agent';
const macServiceFile = path.join(home, 'Library', 'LaunchAgents', `${macServiceLabel}.plist`);
const macLogFile = path.join(home, 'Library', 'Logs', 'remcp-agent.log');
const windowsTaskName = 'ReMCP Agent';
// How npm is invoked is resolved from the running node when possible: a background service has a
// minimal PATH, which is why auto-update used to find no npm on macOS. See src/npm.mjs.
const npm = resolveNpm();
const officialOrigin = 'https://remcp.site';

function parse(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) { positional.push(rest[i]); continue; }
    const key = rest[i].slice(2);
    flags[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return { command, flags, positional };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
  return result;
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
  return String(result.stdout || '').trim();
}

function loadConfig(required = true) {
  if (!fs.existsSync(configFile)) {
    if (!required) return undefined;
    throw new Error(`ReMCP is not paired. Generate a pairing command at ${officialOrigin}/app/connect`);
  }
  const value = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  // A configuration that only carries preferences (for example after `remcp auto-update off`
  // before pairing) has no runtime yet; it must not fail as if it were corrupt.
  if (value.runtime !== undefined) value.runtime = normalizeRuntime(value.runtime);
  return value;
}

function saveConfig(value) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configFile, 0o600);
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function flagEnabled(value) {
  return value === undefined || value === null ? true : value !== false;
}

// One switch for the whole machine: the client and the runtime it spawns must agree,
// otherwise the runtime would keep reporting after the user opted out.
function telemetryState() {
  const client = readJsonFile(configFile);
  const runtime = readJsonFile(runtimeConfigFile);
  const clientEnabled = flagEnabled(client.telemetryEnabled);
  const runtimeEnabled = flagEnabled(runtime.telemetryEnabled);
  return {
    enabled: clientEnabled && runtimeEnabled,
    clientEnabled,
    runtimeEnabled,
    installReported: client.installReported === true,
    configFile,
    runtimeConfigFile,
    transport: 'paired-agent-only',
    endpoint: null,
    collects: 'tool names, durations, outcomes, error classes, and device health samples',
    neverCollects: 'file paths, file contents, command strings, tool arguments, and tool output',
    thirdParty: false,
    installPing: false,
    remoteFeatureFlags: false,
  };
}

function setTelemetry(enabled) {
  const client = readJsonFile(configFile);
  client.telemetryEnabled = enabled;
  writeJsonFile(configFile, client);
  const runtime = readJsonFile(runtimeConfigFile);
  runtime.telemetryEnabled = enabled;
  writeJsonFile(runtimeConfigFile, runtime);
  return telemetryState();
}

function ensureMachineId() {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(machineIdFile, 'utf8').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
  } catch {}
  const value = randomUUID();
  fs.writeFileSync(machineIdFile, value + '\n', { mode: 0o600 });
  fs.chmodSync(machineIdFile, 0o600);
  return value;
}

function servicePlatform() {
  return process.env.NODE_ENV === 'test' && process.env.REMCP_TEST_PLATFORM ? process.env.REMCP_TEST_PLATFORM : process.platform;
}

function globalPrefix() {
  return output(npm.command, [...npm.args, 'prefix', '--global']);
}

function globalCliPath() {
  const prefix = globalPrefix();
  return servicePlatform() === 'win32' ? path.join(prefix, 'remcp.cmd') : path.join(prefix, 'bin', 'remcp');
}

function npmGlobalInstall(...specs) {
  run(npm.command, [...npm.args, 'install', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
}

function quoteSystemd(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function installLinuxService(cliPath = globalCliPath()) {
  const unit = `[Unit]\nDescription=ReMCP device agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${quoteSystemd(cliPath)} start\nRestart=always\nRestartSec=3\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
  fs.mkdirSync(path.dirname(linuxServiceFile), { recursive: true });
  fs.writeFileSync(linuxServiceFile, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', 'remcp-agent.service']);
}

function macLaunchDomain() {
  if (typeof process.getuid !== 'function') throw new Error('Could not determine the current macOS user');
  return `gui/${process.getuid()}`;
}

function installMacService(cliPath = globalCliPath()) {
  const domain = macLaunchDomain();
  const target = `${domain}/${macServiceLabel}`;
  const cliScript = fs.realpathSync(cliPath);
  fs.mkdirSync(path.dirname(macServiceFile), { recursive: true });
  fs.mkdirSync(path.dirname(macLogFile), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${macServiceLabel}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(cliScript)}</string><string>start</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${xmlEscape(macLogFile)}</string>\n<key>StandardErrorPath</key><string>${xmlEscape(macLogFile)}</string>\n</dict></plist>\n`;
  fs.writeFileSync(macServiceFile, plist, { mode: 0o600 });
  spawnSync('launchctl', ['bootout', domain, macServiceFile], { stdio: 'ignore' });
  run('launchctl', ['bootstrap', domain, macServiceFile]);
  run('launchctl', ['enable', target]);
  run('launchctl', ['kickstart', '-k', target]);
}

function installWindowsService(cliPath = globalCliPath()) {
  const command = `"${cliPath}" start`;
  run('schtasks.exe', ['/Create', '/TN', windowsTaskName, '/TR', command, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']);
  run('schtasks.exe', ['/Run', '/TN', windowsTaskName]);
}

function configurePostInstallAccess() {
  const platform = servicePlatform();
  try {
    if (platform === 'darwin') configureMacWriteAccess();
    else if (platform === 'win32') configureWindowsWriteAccess();
    else configureLinuxWriteAccess();
  } catch (error) {
    console.error(`Could not configure write access: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function configureMacWriteAccess() {
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

function configureWindowsWriteAccess() {
  try { run('schtasks.exe', ['/Change', '/TN', windowsTaskName, '/RL', 'HIGHEST', '/IT']); } catch {}
  try {
    const workspaceDir = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ReMCP');
    fs.mkdirSync(workspaceDir, { recursive: true });
  } catch {}
  console.log('ReMCP configured with elevated privileges for full write access.');
}

function configureLinuxWriteAccess() {
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

function installPersistentAgent(config) {
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
function ensureServiceIfRecorded(config) {
  if (config?.serviceInstalled !== true) return false;
  try {
    const cliPath = globalCliPath();
    const platform = servicePlatform();
    if (platform === 'linux') {
      if (!fs.existsSync(linuxServiceFile)) {
        installLinuxService(cliPath);
      } else {
        // Node managers can move the global npm prefix between updates (nvm -> Hermes was observed in
        // production). An existing systemd unit then keeps launching the old CLI forever even though
        // npm successfully installed the new one. Repair the launcher in place before restarting it.
        const unit = fs.readFileSync(linuxServiceFile, 'utf8');
        const expected = `ExecStart=${quoteSystemd(cliPath)} start`;
        if (!unit.includes(expected)) {
          const repaired = unit.replace(/^ExecStart=.*$/m, expected);
          if (repaired === unit) throw new Error('remcp-agent.service has no ExecStart line to repair');
          fs.writeFileSync(linuxServiceFile, repaired);
          run('systemctl', ['--user', 'daemon-reload']);
        }
      }
    } else if (platform === 'darwin') {
      if (!fs.existsSync(macServiceFile)) installMacService(cliPath);
    } else if (platform === 'win32') installWindowsService(cliPath);
    return true;
  } catch (error) {
    console.error(`Could not ensure the background service: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// Opens the approval page in the person's browser. A machine that nobody is looking at only gets the
// printed URL, so every failure here is silent and non-fatal.
function openInBrowser(url) {
  try {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Device authorization (RFC 8628): the computer asks for a code, the person approves it in the
// browser while signed in, and this process collects the credential by polling. The device never
// sees a browser session or an account password.
async function pairWithDeviceCode(server, flags) {
  const authorization = await fetch(`${server}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: String(flags.name || os.hostname()),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      machineId: ensureMachineId(),
    }),
  });
  if (!authorization.ok) throw new Error(`Pairing failed (${authorization.status}): ${await authorization.text()}`);
  const grant = await authorization.json();
  const approvalUrl = grant.verification_uri_complete || grant.verification_uri;
  console.log(`Approve this computer in your browser: ${approvalUrl}`);
  console.log(`Pairing code: ${grant.user_code}  (expires in ${Math.max(1, Math.round(Number(grant.expires_in || 600) / 60))} minutes)`);
  openInBrowser(approvalUrl);
  console.log('Waiting for approval… (Ctrl+C to cancel)');
  const deadline = Date.now() + (Number(grant.expires_in) || 600) * 1000;
  let lastReminder = Date.now();
  const intervalMs = Math.max(1, Number(grant.interval) || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const response = await fetch(`${server}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: String(grant.device_code || ''),
        machineId: ensureMachineId(),
      }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.device_token) return data;
    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      if (Date.now() - lastReminder > 60_000) {
        lastReminder = Date.now();
        const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
        console.log(`Still waiting — approve at ${approvalUrl} (about ${left} min left)`);
      }
      continue;
    }
    if (data.error === 'access_denied') throw new Error('That pairing request was denied in the browser. Run the command again if it was not you.');
    if (data.error === 'expired_token') break;
    throw new Error(`Pairing failed (${response.status}): ${JSON.stringify(data)}`);
  }
  throw new Error('The pairing code expired before it was approved. Run the command again.');
}

function restartPersistentServiceIfInstalled() {
  const platform = servicePlatform();
  if (platform === 'linux' && fs.existsSync(linuxServiceFile)) {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'restart', 'remcp-agent.service']);
    return 'remcp-agent.service';
  }
  if (platform === 'darwin' && fs.existsSync(macServiceFile)) {
    run('launchctl', ['kickstart', '-k', `${macLaunchDomain()}/${macServiceLabel}`]);
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

// The agent the user installed with `remcp install` is the one this CLI manages. A machine can also
// be supervised by its own systemd unit, by Docker, or by a terminal, and in those cases installing
// a new version is not enough: the running process keeps the old code until something restarts it.
// `supervisorRestart` (agent.mjs) answers which of those is true, and only reports a service manager
// when it really owns this process: a terminal gets an explicit instruction instead of a silent exit
// that would take the device offline.
// One real handshake with the local runtime, plus everything needed to explain a failure: where the
// entry resolved, whether the package is installed, the node that would run it, and the exact error.
async function diagnoseLocalRuntime(cfg) {
  const packageName = cfg.runtime?.packageName || '';
  const diagnosis = {
    platform: `${process.platform} ${process.arch}`,
    node: process.execPath,
    nodeVersion: process.versions.node,
    packageName,
    packageSpec: cfg.runtime?.packageSpec || '',
    installedRuntime: installedVersion(packageName),
    installedClient: installedVersion(PACKAGE_NAME),
  };
  const resolved = resolveNpm();
  const npmInfo = npmVersion(resolved);
  diagnosis.npm = npmInfo ? { version: npmInfo.version, source: npmInfo.source } : { error: `npm could not be executed (tried ${resolved.source})` };
  let entry = '';
  try {
    entry = localRuntimeEntry(cfg.runtime);
    diagnosis.entry = entry;
    diagnosis.entryExists = fs.existsSync(entry);
  } catch (error) {
    diagnosis.entry = null;
    diagnosis.entryExists = false;
    diagnosis.verdict = 'runtime-not-installed';
    diagnosis.error = error instanceof Error ? error.message : String(error);
    diagnosis.hint = `Reinstall with: npx --yes ${PACKAGE_NAME}@latest update`;
    return diagnosis;
  }
  if (!diagnosis.entryExists) {
    diagnosis.verdict = 'runtime-entry-missing';
    diagnosis.hint = `Reinstall with: npx --yes ${PACKAGE_NAME}@latest update`;
    return diagnosis;
  }
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'remcp-doctor', version: VERSION });
    const stdio = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env }, maxBufferSize: 4 * 1024 * 1024 });
    const stderr = [];
    stdio.onerror = error => stderr.push(String(error?.message || error));
    await client.connect(stdio);
    diagnosis.runtimeVersion = client.getServerVersion()?.version || 'unknown';
    const tools = await client.listTools(undefined, { timeout: 20000 });
    diagnosis.tools = tools.tools.length;
    diagnosis.verdict = 'ok';
    await client.close();
    return diagnosis;
  } catch (error) {
    diagnosis.verdict = 'runtime-handshake-failed';
    diagnosis.error = error instanceof Error ? error.message : String(error);
    diagnosis.hint = 'Run the entry above by hand to see its output, then reinstall with: npx --yes @remcp/remcp@latest update';
    return diagnosis;
  }
}

// Reads the version a freshly installed global package reports, so an update that installed
// nothing (wrong prefix, npm cache, permissions) is reported instead of assumed successful.
// The roots the runtime is allowed to work in, as the person configured them. An empty list means
// "the whole file system", so the doctor probes the home directory instead of guessing a root.
function runtimeAllowedRoots() {
  try {
    const configured = JSON.parse(fs.readFileSync(runtimeConfigFile, 'utf8')).allowedRoots;
    if (Array.isArray(configured) && configured.length) return configured.map(root => String(root).replace(/^~/, os.homedir()));
  } catch {}
  return [os.homedir()];
}

function installedVersion(packageName) {
  const prefix = spawnSync(npm.command, [...npm.args, 'prefix', '--global'], { encoding: 'utf8' });
  if (prefix.error || prefix.status !== 0) return null;
  const manifest = path.join(String(prefix.stdout || '').trim(), 'lib', 'node_modules', ...packageName.split('/'), 'package.json');
  try { return JSON.parse(fs.readFileSync(manifest, 'utf8')).version || null; } catch { return null; }
}

function uninstallPersistentService() {
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

function assertRuntimeTrust(server, flags) {
  const origin = new URL(server).origin;
  if (origin !== officialOrigin && !flags['trust-runtime']) {
    throw new Error('Custom servers can provide local runtime metadata. Re-run with --trust-runtime only if you trust that server.');
  }
}

function printHelp() {
  console.log(`ReMCP ${VERSION}\n\nCommands:\n  remcp start\n  remcp status\n  remcp doctor\n  remcp update\n  remcp install\n  remcp uninstall\n  remcp uninstall --purge\n  remcp telemetry [status|on|off]\n  remcp --version\n\nPairing commands are generated in the ReMCP workspace.\n\nUsage metrics are opt-out (tool names, timings, outcomes only, sent to your own ReMCP\naccount through the paired agent). Disable them at any time with: remcp telemetry off`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags, positional } = parse(argv);

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VERSION);
    return;
  }

  if (command === 'connect') {
    // Like the desktop-app flow this mirrors: with no flags the command talks to the official
    // server, prints a code, opens the browser to approve it, and pairs. `--code` keeps working for
    // the workspace-generated command and for CI, and `--server` for self-hosted deployments.
    const server = String(flags.server || officialOrigin).replace(/\/$/, '');
    const code = String(flags.code || '').replace(/\s+/g, '').toUpperCase();
    assertRuntimeTrust(server, flags);
    let paired;
    let deviceInitiated = false;
    if (code) {
      const response = await fetch(`${server}/api/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, machineId: ensureMachineId(), name: String(flags.name || os.hostname()), hostname: os.hostname(), platform: process.platform, arch: process.arch }),
      });
      if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${await response.text()}`);
      paired = await response.json();
    } else {
      deviceInitiated = true;
      paired = await pairWithDeviceCode(server, flags);
    }
    if (paired.moved_from_another_account) {
      console.log('This computer was paired to another ReMCP account. That device was revoked and this machine now belongs to the account you approved.');
    } else if (paired.movedFromUid) {
      console.log('This computer was paired to another ReMCP account. That device was revoked and this machine now belongs to the account you approved.');
    }
    const config = {
      serverUrl: server,
      deviceId: paired.deviceId || paired.device_id,
      deviceToken: paired.deviceToken || paired.device_token,
      deviceName: String(flags.name || os.hostname()),
      runtime: normalizeRuntime(paired.runtime),
      machineId: ensureMachineId(),
      // Remember whether this machine's owner trusted the server to name a runtime version. The
      // auto-updater must not widen that decision on its own later.
      trustRuntime: Boolean(flags['trust-runtime']) || new URL(server).origin === officialOrigin,
    };
    saveConfig(config);
    const accountEmail = String(paired.account?.email || '');
    console.log(`Paired ${os.hostname()} with ${server}${accountEmail ? ` as ${accountEmail}` : ''}`);
    if (flags.install) {
      installPersistentAgent(config);
      return;
    }
    // Only the command that asked for its own code keeps running: someone who ran `remcp connect` on
    // a fresh machine expects the connection to be live when the command finishes. A workspace code
    // keeps its old meaning (pair, then `remcp start` or `--install`).
    if (!deviceInitiated) return;
    // The machine survives a reboot afterwards. Nothing about the credential
    // changes: the same revocable token is used either way.
    installPersistentAgent(config);
    return;
  }

  if (command === 'start') {
    const cfg = loadConfig();
    const telemetry = telemetryState();
    await runAgent({
      ...cfg,
      autoUpdate: cfg.autoUpdate !== false,
      trustRuntime: cfg.trustRuntime === true
        || process.env.REMCP_TRUST_RUNTIME === '1'
        || new URL(cfg.serverUrl).origin === officialOrigin,
      telemetryEnabled: telemetry.enabled,
      installReported: telemetry.installReported,
      installSpec: `${PACKAGE_NAME}@${VERSION}`,
      persistState: patch => saveConfig({ ...cfg, ...patch }),
    });
    return;
  }

  if (command === 'auto-update') {
    const action = String(positional[0] || 'status').toLowerCase();
    const cfg = loadConfig(false) || {};
    if (action === 'status') {
      console.log(JSON.stringify({ autoUpdate: cfg.autoUpdate !== false, checkIntervalHours: 6 }, null, 2));
      return;
    }
    if (action === 'on' || action === 'enable') { saveConfig({ ...cfg, autoUpdate: true }); console.log('Auto-update enabled.'); return; }
    if (action === 'off' || action === 'disable') { saveConfig({ ...cfg, autoUpdate: false }); console.log('Auto-update disabled. Run `remcp update` yourself when you want a new version.'); return; }
    throw new Error('Usage: remcp auto-update [status|on|off]');
  }

  if (command === 'telemetry') {
    const action = String(positional[0] || 'status').toLowerCase();
    if (action === 'status') {
      console.log(JSON.stringify(telemetryState(), null, 2));
      return;
    }
    if (action === 'on' || action === 'enable') {
      console.log(JSON.stringify(setTelemetry(true), null, 2));
      restartPersistentServiceIfInstalled();
      console.log('Usage metrics enabled and the agent restarted to apply it.');
      return;
    }
    if (action === 'off' || action === 'disable') {
      console.log(JSON.stringify(setTelemetry(false), null, 2));
      restartPersistentServiceIfInstalled();
      console.log('Usage metrics disabled and the agent restarted to apply it.');
      return;
    }
    throw new Error('Usage: remcp telemetry [status|on|off]');
  }

  if (command === 'status' || command === 'doctor') {
    const cfg = loadConfig();
    const health = await fetch(`${cfg.serverUrl}/health?fresh=${Date.now()}`, { cache: 'no-store' }).then(r => r.json()).catch(error => ({ error: error.message }));
    const report = {
      configured: true,
      cliVersion: VERSION,
      deviceId: cfg.deviceId,
      deviceName: cfg.deviceName,
      server: cfg.serverUrl,
      runtime: cfg.runtime,
      telemetry: telemetryState(),
      serverHealth: health,
    };
    // `doctor` answers the question the workspace cannot: is this machine actually able to run a
    // tool? It resolves the runtime entry, installs nothing, and tries one real MCP handshake with
    // the runtime, so the failure is visible here instead of only as "runtime not running".
    if (command === 'doctor') {
      report.diagnosis = await diagnoseLocalRuntime(cfg);
      // A computer can pass every other check and still be unable to write where the tools work:
      // macOS answers EACCES for Desktop until TCC is granted, Windows has Controlled folder access,
      // Linux answers EACCES for a folder this user does not own. The probe writes and removes a
      // temporary file in each allowed root, so the doctor reports what actually happens rather than
      // what the permission bits claim, and names the fix for this platform and this binary.
      report.diagnosis.filesystem = await probeFilesystemAccess({ roots: runtimeAllowedRoots() });
    }
    console.log(JSON.stringify(report, null, 2));
    if (command === 'doctor' && report.diagnosis.verdict !== 'ok') process.exitCode = 1;
    return;
  }

  if (command === 'install') {
    installPersistentAgent(loadConfig());
    return;
  }

  if (command === 'update') {
    const cfg = loadConfig();
    // The server advertises which runtime version it expects; an agent that is updating
    // itself passes it through so client and runtime move together.
    const requested = typeof flags.runtime === 'string' ? flags.runtime.trim() : '';
    // Whatever the server advertises is installed globally, so it is validated exactly like the
    // metadata from a pairing response: same package as the configured runtime, a spec that
    // parses, and an explicit --trust-runtime before a custom server may change it.
    let runtimeSpec = cfg.runtime.packageSpec;
    if (requested) {
      // Only `<configured package>@<semver>` is installable: an alias, a git/URL/file spec, a tag or
      // a range would run code the user never agreed to.
      if (!isRuntimeSpecFor(cfg.runtime.packageName, requested)) {
        throw new Error(`--runtime must be ${cfg.runtime.packageName}@<version>`);
      }
      const trusted = cfg.trustRuntime === true
        || Boolean(flags['trust-runtime'])
        || process.env.REMCP_TRUST_RUNTIME === '1'
        // A configuration written before the field existed paired with the official server, which is
        // trusted by definition; refusing it would silently stop every existing device updating.
        || new URL(cfg.serverUrl).origin === officialOrigin;
      if (!trusted) {
        throw new Error(`This machine was paired without trusting ${cfg.serverUrl} to choose a runtime version. Re-run with --trust-runtime if you trust that server.`);
      }
      runtimeSpec = normalizeRuntime({ kind: 'npm', packageName: cfg.runtime.packageName, packageSpec: requested, entry: cfg.runtime.entry }).packageSpec;
    }
    if (flags.check) {
      console.log(JSON.stringify({
        current: VERSION,
        installedRuntime: installedVersion(cfg.runtime.packageName),
        runtimeSpec: runtimeSpec,
        available: `${PACKAGE_NAME}@latest`,
        managedService: fs.existsSync(linuxServiceFile) || fs.existsSync(macServiceFile),
        supervisor: supervisorRestart() ?? 'none',
      }, null, 2));
      return;
    }
    const before = { cli: VERSION, runtime: installedVersion(cfg.runtime.packageName) };
    console.log(`Updating ReMCP to the latest published version (${runtimeSpec})…`);
    npmGlobalInstall(`${PACKAGE_NAME}@latest`, runtimeSpec);
    // The npm prefix can change across Node-manager upgrades. Repair an existing persistent-service
    // launcher only after the install, when globalCliPath() points at the CLI we just installed.
    ensureServiceIfRecorded(cfg);
    // Only a validated spec is persisted, so a failed update cannot leave the install unable to start.
    if (requested && runtimeSpec !== cfg.runtime.packageSpec) saveConfig({ ...cfg, runtime: { ...cfg.runtime, packageSpec: runtimeSpec } });
    const after = { cli: installedVersion(PACKAGE_NAME), runtime: installedVersion(cfg.runtime.packageName) };
    const restarted = restartPersistentServiceIfInstalled();
    if (restarted) {
      console.log(`ReMCP updated and ${restarted} restarted (client ${before.cli} → ${after.cli ?? '?'}, runtime ${before.runtime ?? '?'} → ${after.runtime ?? '?'}).`);
      return;
    }
    // This process is the updater, not the agent: exiting here would restart nothing. The agent sees
    // the exit status, verifies the installed version, and restarts itself.
    console.log(`ReMCP updated (client ${before.cli} → ${after.cli ?? '?'}, runtime ${before.runtime ?? '?'} → ${after.runtime ?? '?'}). The running agent restarts itself to apply it.`);
    if (after.cli === before.cli && after.runtime === before.runtime) {
      console.log('Nothing changed: the installed versions already match the requested ones.');
    }
    return;
  }

  if (command === 'uninstall') {
    uninstallPersistentService();
    if (flags.purge) {
      const cfg = loadConfig(false);
      const specs = [PACKAGE_NAME, ...(cfg?.runtime?.packageName ? [cfg.runtime.packageName] : [])];
      run(npm.command, [...npm.args, 'uninstall', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
    }
    return;
  }

  printHelp();
}
