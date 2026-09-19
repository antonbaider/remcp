import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { VERSION } from '../src/version.mjs';

const bin = path.resolve('bin/remcp.mjs');

function fakeExecutable(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

test('install uses a stable global CLI path and update refreshes/restarts it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'systemctl'), 'echo "systemctl $@" >> "$REMCP_TEST_LOG"');
  const env = { ...process.env, HOME: home, REMCP_CONFIG_DIR: configDir, REMCP_TEST_LOG: log, REMCP_TEST_PREFIX: prefix, PATH: `${fakeBin}:${process.env.PATH}`, REMCP_NPM: path.join(fakeBin, 'npm') };

  const install = spawnSync(process.execPath, [bin, 'install'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const unit = readFileSync(path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service'), 'utf8');
  assert.match(unit, new RegExp(`ExecStart="${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp" start`));
  let calls = readFileSync(log, 'utf8');
  assert.match(calls, new RegExp(`npm install --global @remcp/remcp@${VERSION.replaceAll('.', '\\.')}`));
  assert.match(calls, /@example\/local-runtime@1\.2\.3/);
  assert.match(calls, /systemctl --user enable --now remcp-agent\.service/);

  // Reproduce a real upgrade from one Node manager to another: the service still points at a CLI in
  // an old nvm prefix while npm now installs to the current global prefix. Update must repair the unit
  // before it restarts it, otherwise the old agent reconnects and starts the same update again.
  const serviceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  writeFileSync(serviceFile, readFileSync(serviceFile, 'utf8').replace(`${prefix}/bin/remcp`, '/old/nvm/bin/remcp'));

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const repairedUnit = readFileSync(serviceFile, 'utf8');
  assert.match(repairedUnit, new RegExp(`ExecStart=\"${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp\" start`));
  assert.doesNotMatch(repairedUnit, /old\/nvm/);
  calls = readFileSync(log, 'utf8');
  assert.match(calls, /npm install --global @remcp\/remcp@latest/);
  assert.match(calls, /systemctl --user daemon-reload/);
  assert.match(calls, /systemctl --user restart remcp-agent\.service/);
});

// A unit that lost its ExecStart line cannot be patched by substitution; the launcher has to be
// rewritten, or the machine keeps starting the CLI from a prefix npm no longer installs into.
test('a systemd unit without ExecStart is rewritten instead of leaving the old CLI running', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', serviceInstalled: true, runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'systemctl'), 'echo "systemctl $@" >> "$REMCP_TEST_LOG"');
  const env = { ...process.env, HOME: home, REMCP_CONFIG_DIR: configDir, REMCP_TEST_LOG: log, REMCP_TEST_PREFIX: prefix, PATH: `${fakeBin}:${process.env.PATH}`, REMCP_NPM: path.join(fakeBin, 'npm') };

  const unitFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  mkdirSync(path.dirname(unitFile), { recursive: true });
  writeFileSync(unitFile, '[Unit]\nDescription=ReMCP device agent\n\n[Service]\n# hand-edited, the launcher line is gone\nRestart=always\n');

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const unit = readFileSync(unitFile, 'utf8');
  assert.match(unit, new RegExp(`ExecStart="${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp" start`), 'the unit is rewritten for the prefix npm installed into');
  assert.doesNotMatch(unit, /hand-edited/);
});

// macOS keeps the interpreter and the CLI path inside the launchd plist, so the same prefix change
// leaves launchd starting a deleted file. The plist has to be rewritten, not just recreated when
// missing — the machine otherwise loops like the Linux unit used to.
test('a macOS plist pointing at an old prefix is rewritten', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', serviceInstalled: true, runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'launchctl'), 'echo "launchctl $@" >> "$REMCP_TEST_LOG"');
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.remcp.agent.plist');
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ProgramArguments</key><array><string>${process.execPath}</string><string>/old/nvm/bin/remcp</string><string>start</string></array></dict></plist>\n`);
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    // `servicePlatform()` only honours the override under NODE_ENV=test.
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const plist = readFileSync(plistFile, 'utf8');
  assert.doesNotMatch(plist, /old\/nvm/, 'the plist no longer launches the deleted CLI');
  assert.match(plist, new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp`));
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /launchctl print gui\/\d+\/com\.remcp\.agent/);
  assert.match(calls, /launchctl submit -l com\.remcp\.agent\.reload\./,
    'a loaded stale job is handed to an independent launchd repair helper');
  assert.doesNotMatch(calls, /launchctl bootout/, 'the updater itself never boots out its owning job inline');
});


// Releases before serviceInstalled was persisted can still have a valid LaunchAgent plist on disk.
// If launchd has forgotten that job (logout cleanup, migration, manual bootout), update must infer
// that this is a managed install from the plist and bootstrap it again before trying kickstart.
test('a legacy macOS install re-bootstraps an unloaded LaunchAgent during update', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  const loaded = path.join(root, 'launchd-loaded');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  // Intentionally no serviceInstalled flag: this is the persisted shape from older clients.
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'launchctl'), [
    'echo "launchctl $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "print" ]; then [ -f "$REMCP_LAUNCHD_LOADED" ]; exit $?; fi',
    'if [ "$1" = "bootout" ]; then rm -f "$REMCP_LAUNCHD_LOADED"; exit 0; fi',
    'if [ "$1" = "bootstrap" ]; then touch "$REMCP_LAUNCHD_LOADED"; exit 0; fi',
    'if [ "$1" = "kickstart" ] && [ ! -f "$REMCP_LAUNCHD_LOADED" ]; then echo "Could not find service com.remcp.agent" >&2; exit 113; fi',
    'exit 0',
  ].join('\n'));
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.remcp.agent.plist');
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>ProgramArguments</key><array><string>${process.execPath}</string><string>${prefix}/bin/remcp</string><string>start</string></array></dict></plist>\n`);
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    REMCP_LAUNCHD_LOADED: loaded,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /launchctl bootout/, 'an already-unloaded job can be bootstrapped directly');
  assert.match(calls, /launchctl bootstrap/);
  assert.match(calls, /launchctl submit -l com\.remcp\.agent\.restart\./,
    'the post-update restart is handed to an independent launchd helper');
});


test('an explicit service opt-out is stronger than a stale macOS plist', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    configSchemaVersion: 1,
    serverUrl: 'https://example.invalid',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    serviceInstalled: false,
    runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'launchctl'), 'echo "launchctl $@" >> "$REMCP_TEST_LOG"');
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.remcp.agent.plist');
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, '<plist><dict></dict></plist>\n');
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.doesNotMatch(calls, /launchctl/, 'an explicit opt-out must not restart or recreate the stale job');
});


test('a legacy Linux user service is inferred, repaired, and recorded during update', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    serverUrl: 'https://example.invalid',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'systemctl'), 'echo "systemctl $@" >> "$REMCP_TEST_LOG"');
  const serviceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  mkdirSync(path.dirname(serviceFile), { recursive: true });
  writeFileSync(serviceFile, '[Service]\nExecStart="/old/node/bin/remcp" start\nRestart=always\n');
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'linux',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  assert.match(readFileSync(serviceFile, 'utf8'), new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp`));
  const saved = JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  assert.equal(saved.serviceInstalled, true);
  assert.equal(saved.configSchemaVersion, 1);
});

test('a legacy Windows scheduled task is inferred and refreshed during update', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    serverUrl: 'https://example.invalid',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'schtasks.exe'), 'echo "schtasks $@" >> "$REMCP_TEST_LOG"\nexit 0');
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'win32',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /schtasks \/Query \/TN ReMCP Agent/);
  assert.match(calls, /schtasks \/Create \/TN ReMCP Agent/);
  const saved = JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf8'));
  assert.equal(saved.serviceInstalled, true);
  assert.equal(saved.configSchemaVersion, 1);
});


test('an update of an already-loaded macOS service never boots out its own updater', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  const loaded = path.join(root, 'launchd-loaded');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    configSchemaVersion: 1,
    serverUrl: 'https://example.invalid',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    serviceInstalled: true,
    runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' },
  }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'launchctl'), [
    'echo "launchctl $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "print" ]; then [ -f "$REMCP_LAUNCHD_LOADED" ]; exit $?; fi',
    'if [ "$1" = "bootout" ]; then rm -f "$REMCP_LAUNCHD_LOADED"; exit 0; fi',
    'if [ "$1" = "bootstrap" ]; then touch "$REMCP_LAUNCHD_LOADED"; exit 0; fi',
    'exit 0',
  ].join('\n'));
  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    REMCP_TEST_PREFIX: prefix,
    REMCP_LAUNCHD_LOADED: loaded,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
    REMCP_NPM: path.join(fakeBin, 'npm'),
  };

  const install = spawnSync(process.execPath, [bin, 'install'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  writeFileSync(log, '');

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /launchctl print gui\/\d+\/com\.remcp\.agent/);
  assert.doesNotMatch(calls, /launchctl bootout/, 'an in-place update must not unload the job that owns the updater');
  assert.doesNotMatch(calls, /launchctl bootstrap/, 'an already-loaded unchanged job does not need re-bootstrap');
  assert.match(calls, /launchctl submit -l com\.remcp\.agent\.restart\./,
    'the loaded service is restarted out-of-process after the updater returns');
});


test('macOS preference changes restart a loaded agent through the detached helper too', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    configSchemaVersion: 1,
    serverUrl: 'https://example.invalid',
    serviceInstalled: true,
  }));
  writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({ telemetryEnabled: true }));
  fakeExecutable(path.join(fakeBin, 'launchctl'), [
    'echo "launchctl $@" >> "$REMCP_TEST_LOG"',
    'if [ "$1" = "print" ]; then exit 0; fi',
    'exit 0',
  ].join('\n'));
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.remcp.agent.plist');
  mkdirSync(path.dirname(plistFile), { recursive: true });
  writeFileSync(plistFile, '<plist><dict></dict></plist>\n');

  const env = {
    ...process.env,
    HOME: home,
    REMCP_CONFIG_DIR: configDir,
    REMCP_TEST_LOG: log,
    NODE_ENV: 'test',
    REMCP_TEST_PLATFORM: 'darwin',
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const result = spawnSync(process.execPath, [bin, 'telemetry', 'off'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const calls = readFileSync(log, 'utf8');
  assert.match(calls, /launchctl print gui\/\d+\/com\.remcp\.agent/);
  assert.match(calls, /launchctl submit -l com\.remcp\.agent\.restart\./);
  assert.doesNotMatch(calls, /launchctl bootout/);
  assert.doesNotMatch(calls, /launchctl kickstart -k/, 'the caller must return before the helper performs the destructive restart');
});
