import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The CLI resolves its config directory at import time, so point it at a scratch
// directory before loading the module. Never touch the developer's real ~/.config/remcp,
// and never restart a real user service from a test run.
const configDir = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-test-'));
process.env.REMCP_CONFIG_DIR = configDir;
process.env.NODE_ENV = 'test';
process.env.REMCP_TEST_PLATFORM = 'aix';

const { main } = await import('../src/cli.mjs');
const { ensureMachineId } = await import('../src/cli/config.mjs');
const { PACKAGE_NAME, VERSION } = await import('../src/version.mjs');

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

test('CLI version is sourced from package metadata', async () => {
  assert.equal(PACKAGE_NAME, '@remcp/remcp');
  assert.equal(VERSION, packageVersion);
  assert.equal(await captureLog(() => main(['--version'])), packageVersion);
});

test('machine identity stays stable across reconnect-style config changes', () => {
  const machineIdFile = path.join(configDir, 'machine-id');
  rmSync(machineIdFile, { force: true });

  const first = ensureMachineId();
  writeFileSync(path.join(configDir, 'config.json'), '{}\n');
  rmSync(path.join(configDir, 'config.json'), { force: true });
  const second = ensureMachineId();

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(second, first);
  assert.equal(readFileSync(machineIdFile, 'utf8').trim(), first);
  if (process.platform !== 'win32') assert.equal(statSync(machineIdFile).mode & 0o777, 0o600);
});

test('CLI help keeps pairing in the workspace and documents update lifecycle', async () => {
  const help = await captureLog(() => main(['help']));
  assert.match(help, /Pairing commands are generated in the ReMCP workspace/);
  assert.match(help, /remcp update/);
  assert.match(help, /remcp uninstall --purge/);
  assert.match(help, /remcp telemetry \[status\|on\|off\]/);
  assert.match(help, /opt-out/i);
});

test('telemetry is opt-out through one switch that covers the client and the runtime', async () => {
  const clientFile = path.join(configDir, 'config.json');
  const runtimeFile = path.join(configDir, 'runtime.json');
  writeFileSync(clientFile, '{}\n');

  try {
    const initial = JSON.parse(await captureLog(() => main(['telemetry', 'status'])));
    assert.equal(initial.enabled, true, 'metrics start enabled and can be turned off');
    assert.equal(initial.installPing, false, 'there is no install ping');
    assert.equal(initial.thirdParty, false);
    assert.equal(initial.endpoint, null);
    assert.equal(initial.transport, 'paired-agent-only');

    await captureLog(() => main(['telemetry', 'off']));
    assert.equal(JSON.parse(readFileSync(clientFile, 'utf8')).telemetryEnabled, false);
    assert.equal(JSON.parse(readFileSync(runtimeFile, 'utf8')).telemetryEnabled, false, 'the runtime switch must follow the client switch');
    assert.equal(JSON.parse(await captureLog(() => main(['telemetry', 'status']))).enabled, false);

    await captureLog(() => main(['telemetry', 'on']));
    assert.equal(JSON.parse(readFileSync(clientFile, 'utf8')).telemetryEnabled, true);
    assert.equal(JSON.parse(readFileSync(runtimeFile, 'utf8')).telemetryEnabled, true);
    assert.equal(JSON.parse(await captureLog(() => main(['telemetry', 'status']))).enabled, true);

    await assert.rejects(() => main(['telemetry', 'sideways']), /Usage: remcp telemetry/);
  } finally {
    rmSync(clientFile, { force: true });
    rmSync(runtimeFile, { force: true });
  }
});


test('legacy client config migrates to the canonical service without dropping unknown fields', async () => {
  const clientFile = path.join(configDir, 'config.json');
  writeFileSync(clientFile, JSON.stringify({
    serverUrl: 'https://remcp.delio24.com',
    deviceId: 'legacy-device',
    deviceToken: 'legacy-token',
    deviceName: 'Legacy Mac',
    runtime: { kind: 'npm', packageName: '@remcp/runtime', packageSpec: '@remcp/runtime@0.1.4', entry: 'src/index.mjs' },
    preservedFutureField: { keep: true },
  }) + '\n');

  try {
    await captureLog(() => main(['auto-update', 'status']));
    const migrated = JSON.parse(readFileSync(clientFile, 'utf8'));
    assert.equal(migrated.configSchemaVersion, 1);
    assert.equal(migrated.serverUrl, 'https://remcp.site');
    assert.equal(migrated.trustRuntime, true, 'the former official host remains trusted after canonicalization');
    assert.deepEqual(migrated.preservedFutureField, { keep: true }, 'migrations are additive and preserve unknown data');
  } finally {
    rmSync(clientFile, { force: true });
  }
});

test('uninstall records an explicit service opt-out so a later update cannot resurrect it', async () => {
  const clientFile = path.join(configDir, 'config.json');
  writeFileSync(clientFile, JSON.stringify({
    configSchemaVersion: 1,
    serverUrl: 'https://remcp.site',
    deviceId: 'test',
    deviceToken: 'test',
    deviceName: 'test',
    serviceInstalled: true,
    runtime: { kind: 'npm', packageName: '@remcp/runtime', packageSpec: '@remcp/runtime@0.2.43', entry: 'src/index.mjs' },
  }) + '\n');

  try {
    await captureLog(() => main(['uninstall']));
    const saved = JSON.parse(readFileSync(clientFile, 'utf8'));
    assert.equal(saved.serviceInstalled, false);
    assert.equal(saved.configSchemaVersion, 1);
  } finally {
    rmSync(clientFile, { force: true });
  }
});


test('a newer config schema is never downgraded and unknown fields survive local writes', async () => {
  const clientFile = path.join(configDir, 'config.json');
  writeFileSync(clientFile, JSON.stringify({
    configSchemaVersion: 99,
    serverUrl: 'https://future.example.invalid',
    futureEnvelope: { generation: 7, opaque: ['keep', 'me'] },
  }) + '\n');

  try {
    await captureLog(() => main(['auto-update', 'off']));
    const saved = JSON.parse(readFileSync(clientFile, 'utf8'));
    assert.equal(saved.configSchemaVersion, 99);
    assert.deepEqual(saved.futureEnvelope, { generation: 7, opaque: ['keep', 'me'] });
    assert.equal(saved.autoUpdate, false);
  } finally {
    rmSync(clientFile, { force: true });
  }
});
