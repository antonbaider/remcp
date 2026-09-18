import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { freshWorkspace } from './helpers.mjs';

const root = freshWorkspace('telemetry-on');

const { telemetryStatus, setTelemetrySink, resetTelemetryForTests, flush } = await import('../src/telemetry.mjs');
const { invokeTool } = await import('../src/invoke.mjs');

test('usage metrics are on by default, without any install ping', () => {
  const status = telemetryStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.installPing, false);
  assert.equal(status.remoteFeatureFlags, false);
  assert.equal(status.thirdParty, false);
  assert.equal(status.endpoint, null);
});

test('tool calls produce a whitelisted batch and never leak paths, commands or arguments', async () => {
  resetTelemetryForTests();
  const batches = [];
  setTelemetrySink(async payload => { batches.push(payload); });
  const secretPath = join(root, 'ssh', 'id_rsa');
  await invokeTool('write_file', { path: secretPath, content: 'PRIVATE-KEY-MATERIAL' });
  await invokeTool('start_process', { command: 'echo SUPERSECRETVALUE', timeout_ms: 500 });
  await flush();
  assert.ok(batches.length >= 1, 'expected at least one flushed batch');
  const serialized = JSON.stringify(batches);
  assert.doesNotMatch(serialized, /id_rsa/);
  assert.doesNotMatch(serialized, /PRIVATE-KEY-MATERIAL/);
  assert.doesNotMatch(serialized, /SUPERSECRETVALUE/);
  assert.doesNotMatch(serialized, /echo SUPERSECRET/);
  const events = batches.flatMap(batch => batch.events);
  assert.ok(events.length >= 2);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), Object.keys(event).filter(key => ['event', 'at', 'tool', 'durationMs', 'success', 'errorKind', 'sessionKind', 'reason', 'count'].includes(key)).sort());
    assert.equal(typeof event.event, 'string');
    assert.equal(typeof event.at, 'number');
  }
  assert.ok(events.some(event => event.event === 'tool_call' && event.tool === 'write_file' && event.success === true));
});

test('flushing clears the queue and reports counters', async () => {
  resetTelemetryForTests();
  setTelemetrySink(async () => {});
  await invokeTool('list_directory', { path: root });
  const status = telemetryStatus();
  assert.equal(status.counters.toolCalls, 1);
  await flush();
  assert.equal(telemetryStatus().buffered, 0);
});
