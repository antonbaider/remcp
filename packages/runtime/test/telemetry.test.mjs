import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { join } from 'node:path';
import { freshWorkspace } from './helpers.mjs';

const root = freshWorkspace('telemetry-off');

process.env.REMCP_RUNTIME_DISABLE_TELEMETRY = '1';

const { telemetryStatus, recordEvent, setTelemetrySink, resetTelemetryForTests, flush } = await import('../src/telemetry.mjs');
const { invokeTool } = await import('../src/invoke.mjs');

test('usage metrics are off when the owner opts out', () => {
  const status = telemetryStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.installPing, false);
  assert.equal(status.remoteFeatureFlags, false);
  assert.equal(status.thirdParty, false);
  assert.equal(status.endpoint, null);
  assert.equal(status.transport, 'paired-agent-only');
});

test('local counters still work while metrics are disabled', async () => {
  resetTelemetryForTests();
  await invokeTool('write_file', { path: join(root, 'counted.txt'), content: 'x\n' });
  await invokeTool('read_file', { path: join(root, 'missing.txt') });
  const status = telemetryStatus();
  assert.equal(status.counters.toolCalls, 2);
  assert.equal(status.counters.toolFailures, 1);
  assert.equal(status.buffered, 0, 'nothing may be buffered for export while opted out');
});

test('opted out, no batch ever reaches a sink', async () => {
  resetTelemetryForTests();
  const received = [];
  setTelemetrySink(async payload => { received.push(payload); });
  recordEvent('tool_call', { tool: 'read_file', durationMs: 3, success: true });
  await flush();
  assert.deepEqual(received, []);
});
