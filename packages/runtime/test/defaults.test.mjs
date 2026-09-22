import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('defaults');
// No REMCP_RUNTIME_DANGEROUS_COMMANDS here on purpose: this file documents the secure
// out-of-the-box policy. Operators can still opt in to warn/allow locally, and godmode remains explicit.
process.env.REMCP_RUNTIME_MAX_OUTPUT_BYTES = String(20 * 1024 * 1024);

const { invokeTool } = await import('../src/invoke.mjs');
const { describeConfig } = await import('../src/config.mjs');

test('catastrophic commands are blocked by default', async () => {
  const result = await invokeTool('start_process', { command: 'mkfs 2>&1 | head -2', timeout_ms: 3000 });
  assert.equal(isError(result), true, body(result));
  assert.match(body(result), /blocked by ReMCP device policy/);
});

test('the destructive-command guardrail blocks by default', () => {
  const described = describeConfig();
  assert.equal(described.dangerousCommands, 'block');
  assert.equal(described.blockedCommands.length, 0);
});

test('file access is unrestricted until allowedRoots is configured', async () => {
  assert.deepEqual(describeConfig().allowedRoots, []);
  const result = await invokeTool('list_directory', { path: root, depth: 1 });
  assert.equal(isError(result), false);
});

test('the output cap is clamped below the transport limit even when configured higher', () => {
  assert.equal(describeConfig().maxOutputBytes, 8 * 1024 * 1024);
  assert.equal(describeConfig().maxOutputBytesCeiling, 8 * 1024 * 1024);
});

test('a fresh device has usage metrics on and no local history', () => {
  const described = describeConfig();
  assert.equal(described.telemetryEnabled, true);
  assert.equal(described.telemetryTransport, 'paired-agent-only');
  assert.equal(described.telemetryEndpoint, undefined);
});

test('screenshots and archives are part of the default surface', async () => {
  const { toolDefinitions } = await import('../src/catalog.mjs');
  const names = toolDefinitions.map(tool => tool.name);
  for (const required of ['take_screenshot', 'read_binary', 'write_binary', 'create_archive', 'extract_archive']) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
  void join;
});
