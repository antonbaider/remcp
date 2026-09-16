import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runAgent } from './agent.mjs';
import { normalizeRuntime } from './runtime.mjs';
import { PACKAGE_NAME, VERSION } from './version.mjs';

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
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const officialOrigin = 'https://remcp.delio24.com';

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
  value.runtime = normalizeRuntime(value.runtime);
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
  return output(npmCommand, ['prefix', '--global']);
}

function globalCliPath() {
  const prefix = globalPrefix();
  return servicePlatform() === 'win32' ? path.join(prefix, 'remcp.cmd') : path.join(prefix, 'bin', 'remcp');
}

function npmGlobalInstall(...specs) {
  run(npmCommand, ['install', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
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
  run('schtasks.exe', ['/Create', '/TN', windowsTaskName, '/TR', command, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F']);
  run('schtasks.exe', ['/Run', '/TN', windowsTaskName]);
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
  console.log('ReMCP is installed as a background service. Future updates: remcp update');
}

function restartPersistentServiceIfInstalled() {
  const platform = servicePlatform();
  if (platform === 'linux' && fs.existsSync(linuxServiceFile)) {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'restart', 'remcp-agent.service']);
  } else if (platform === 'darwin' && fs.existsSync(macServiceFile)) {
    run('launchctl', ['kickstart', '-k', `${macLaunchDomain()}/${macServiceLabel}`]);
  } else if (platform === 'win32') {
    const result = spawnSync('schtasks.exe', ['/Query', '/TN', windowsTaskName], { stdio: 'ignore' });
    if (result.status === 0) run('schtasks.exe', ['/Run', '/TN', windowsTaskName]);
  }
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
    const server = String(flags.server || '').replace(/\/$/, '');
    const code = String(flags.code || '').replace(/\s+/g, '').toUpperCase();
    if (!server || !code) throw new Error('--server and --code are required');
    assertRuntimeTrust(server, flags);
    const response = await fetch(`${server}/api/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, machineId: ensureMachineId(), name: String(flags.name || os.hostname()), hostname: os.hostname(), platform: process.platform, arch: process.arch }),
    });
    if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${await response.text()}`);
    const paired = await response.json();
    const config = {
      serverUrl: server,
      deviceId: paired.deviceId,
      deviceToken: paired.deviceToken,
      deviceName: String(flags.name || os.hostname()),
      runtime: normalizeRuntime(paired.runtime),
      machineId: ensureMachineId(),
    };
    saveConfig(config);
    console.log(`Paired ${os.hostname()} with ${server}`);
    if (flags.install) installPersistentAgent(config);
    return;
  }

  if (command === 'start') {
    const cfg = loadConfig();
    const telemetry = telemetryState();
    await runAgent({
      ...cfg,
      telemetryEnabled: telemetry.enabled,
      installReported: telemetry.installReported,
      installSpec: `${PACKAGE_NAME}@${VERSION}`,
      persistState: patch => saveConfig({ ...cfg, ...patch }),
    });
    return;
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
    const health = await fetch(`${cfg.serverUrl}/health?fresh=${Date.now()}`, { cache: 'no-store' }).then(r => r.json());
    console.log(JSON.stringify({ configured: true, cliVersion: VERSION, deviceId: cfg.deviceId, deviceName: cfg.deviceName, server: cfg.serverUrl, runtime: cfg.runtime, telemetry: telemetryState(), serverHealth: health }, null, 2));
    return;
  }

  if (command === 'install') {
    installPersistentAgent(loadConfig());
    return;
  }

  if (command === 'update') {
    const cfg = loadConfig();
    console.log('Updating ReMCP to the latest published version…');
    npmGlobalInstall(`${PACKAGE_NAME}@latest`, cfg.runtime.packageSpec);
    restartPersistentServiceIfInstalled();
    console.log('ReMCP updated. Run `remcp --version` or `remcp status` to verify.');
    return;
  }

  if (command === 'uninstall') {
    uninstallPersistentService();
    if (flags.purge) {
      const cfg = loadConfig(false);
      const specs = [PACKAGE_NAME, ...(cfg?.runtime?.packageName ? [cfg.runtime.packageName] : [])];
      run(npmCommand, ['uninstall', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
    }
    return;
  }

  printHelp();
}
