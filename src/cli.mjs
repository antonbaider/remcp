import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { runAgent } from './agent.mjs';
import { normalizeRuntime } from './runtime.mjs';
import { PACKAGE_NAME, VERSION } from './version.mjs';

const home = os.homedir();
const configDir = process.env.REMCP_CONFIG_DIR || path.join(home, '.config', 'remcp');
const configFile = path.join(configDir, 'config.json');
const serviceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const officialOrigin = 'https://remcp.delio24.com';

function parse(argv) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    flags[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  return { command, flags };
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

function globalPrefix() {
  return output(npmCommand, ['prefix', '--global']);
}

function globalCliPath() {
  const prefix = globalPrefix();
  return process.platform === 'win32' ? path.join(prefix, 'remcp.cmd') : path.join(prefix, 'bin', 'remcp');
}

function npmGlobalInstall(...specs) {
  run(npmCommand, ['install', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
}

function quoteSystemd(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function installLinuxService(cliPath = globalCliPath()) {
  const unit = `[Unit]\nDescription=ReMCP device agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${quoteSystemd(cliPath)} start\nRestart=always\nRestartSec=3\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`;
  fs.mkdirSync(path.dirname(serviceFile), { recursive: true });
  fs.writeFileSync(serviceFile, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', 'remcp-agent.service']);
}

function installPersistentAgent(config) {
  if (process.platform !== 'linux') throw new Error('Automatic background service installation currently supports Linux');
  console.log(`Installing ReMCP ${VERSION}…`);
  npmGlobalInstall(`${PACKAGE_NAME}@${VERSION}`, config.runtime.packageSpec);
  installLinuxService(globalCliPath());
  console.log('ReMCP is installed as a user service. Future updates: remcp update');
}

function restartLinuxServiceIfInstalled() {
  if (process.platform !== 'linux' || !fs.existsSync(serviceFile)) return;
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'restart', 'remcp-agent.service']);
}

function uninstallLinuxService() {
  if (process.platform !== 'linux') return;
  spawnSync('systemctl', ['--user', 'disable', '--now', 'remcp-agent.service'], { stdio: 'inherit' });
  try { fs.unlinkSync(serviceFile); } catch {}
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
}

function assertRuntimeTrust(server, flags) {
  const origin = new URL(server).origin;
  if (origin !== officialOrigin && !flags['trust-runtime']) {
    throw new Error('Custom servers can provide local runtime metadata. Re-run with --trust-runtime only if you trust that server.');
  }
}

function printHelp() {
  console.log(`ReMCP ${VERSION}\n\nCommands:\n  remcp start\n  remcp status\n  remcp doctor\n  remcp update\n  remcp install\n  remcp uninstall\n  remcp uninstall --purge\n  remcp --version\n\nPairing commands are generated in the ReMCP workspace.`);
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parse(argv);

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
      body: JSON.stringify({ code, name: String(flags.name || os.hostname()), hostname: os.hostname(), platform: process.platform, arch: process.arch }),
    });
    if (!response.ok) throw new Error(`Pairing failed (${response.status}): ${await response.text()}`);
    const paired = await response.json();
    const config = {
      serverUrl: server,
      deviceId: paired.deviceId,
      deviceToken: paired.deviceToken,
      deviceName: String(flags.name || os.hostname()),
      runtime: normalizeRuntime(paired.runtime),
    };
    saveConfig(config);
    console.log(`Paired ${os.hostname()} with ${server}`);
    if (flags.install) installPersistentAgent(config);
    return;
  }

  if (command === 'start') {
    await runAgent(loadConfig());
    return;
  }

  if (command === 'status' || command === 'doctor') {
    const cfg = loadConfig();
    const health = await fetch(`${cfg.serverUrl}/health?fresh=${Date.now()}`, { cache: 'no-store' }).then(r => r.json());
    console.log(JSON.stringify({ configured: true, cliVersion: VERSION, deviceId: cfg.deviceId, deviceName: cfg.deviceName, server: cfg.serverUrl, serverHealth: health }, null, 2));
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
    restartLinuxServiceIfInstalled();
    console.log('ReMCP updated. Run `remcp --version` or `remcp status` to verify.');
    return;
  }

  if (command === 'uninstall') {
    uninstallLinuxService();
    if (flags.purge) {
      const cfg = loadConfig(false);
      const specs = [PACKAGE_NAME, ...(cfg?.runtime?.packageName ? [cfg.runtime.packageName] : [])];
      run(npmCommand, ['uninstall', '--global', ...specs, '--no-audit', '--no-fund', '--loglevel=error']);
    }
    return;
  }

  printHelp();
}
