import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'remcp-runtime-config-'));
process.env.REMCP_RUNTIME_CONFIG_DIR = dir;

const { applyLiveConfig, liveConfig, persistConfigValue, settableKeys, validateConfigValue } = await import('../src/config.mjs');
const { setConfigValueTool } = await import('../src/tools/config.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

// The boundary Desktop Commander does not have: a model may change a preference, never the settings
// that decide what this computer exposes.
test('only preferences and context limits are settable', () => {
  assert.deepEqual([...settableKeys].sort(), ['maxBufferedLines', 'maxOutputBytes', 'maxReadLines', 'telemetryEnabled']);
  for (const forbidden of ['allowedRoots', 'blockedCommands', 'dangerousCommands', 'defaultShell', 'maxWriteBytes', 'name']) {
    assert.throws(() => validateConfigValue(forbidden, 'x'), /Unsupported setting/, `${forbidden} is refused`);
  }
});

test('values are validated, clamped to their range and applied live', async () => {
  assert.equal(validateConfigValue('telemetryEnabled', false), false);
  assert.equal(validateConfigValue('telemetryEnabled', 'off'), false);
  assert.throws(() => validateConfigValue('telemetryEnabled', 'maybe'), /true or false/);
  assert.equal(validateConfigValue('maxReadLines', 900), 900);
  assert.throws(() => validateConfigValue('maxReadLines', 0), /between 1 and 100000/);
  // The output cap can never exceed the transport ceiling the runtime is built around.
  assert.throws(() => validateConfigValue('maxOutputBytes', 1024 * 1024 * 1024), /between 1024 and/);
});

test('a change applies immediately and is written back to runtime.json', async () => {
  const before = liveConfig('maxReadLines');
  const result = JSON.parse((await setConfigValueTool({ key: 'maxReadLines', value: 1234 })).content[0].text);
  assert.equal(result.ok, true);
  assert.equal(result.value, 1234);
  assert.equal(liveConfig('maxReadLines'), 1234, 'the next tool call sees the new limit');
  assert.notEqual(before, 1234);

  const saved = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
  assert.equal(saved.maxReadLines, 1234);

  // A second key merges instead of replacing the file.
  applyLiveConfig('telemetryEnabled', false);
  persistConfigValue('telemetryEnabled', false);
  const merged = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
  assert.deepEqual(merged, { maxReadLines: 1234, telemetryEnabled: false });

  await assert.rejects(async () => setConfigValueTool({ key: 'allowedRoots', value: ['/'] }), /Unsupported setting/);
});
