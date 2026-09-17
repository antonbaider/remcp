import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

// "God mode" is a local switch, never a tool. This exercises it exactly the way the agent starts a
// runtime: environment variable in, tool calls out.
const root = freshWorkspace('unrestricted');
const inside = join(root, 'inside');
const outside = join(root, 'outside');
mkdirSync(inside, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'readable only when the confinement is off\n');
process.env.REMCP_RUNTIME_ALLOWED_ROOTS = inside;
process.env.REMCP_RUNTIME_BLOCKED_COMMANDS = 'rm -rf';
process.env.REMCP_RUNTIME_DANGEROUS_COMMANDS = 'block';
process.env.REMCP_RUNTIME_UNRESTRICTED = '1';
process.env.REMCP_RUNTIME_DISABLE_TELEMETRY = '1';

const { invokeTool } = await import('../src/invoke.mjs');
const { runtimeConfig, settableKeys } = await import('../src/config.mjs');

test('unrestricted mode lifts the root confinement and the command guardrail', async () => {
  assert.equal(runtimeConfig.unrestricted, true);
  assert.deepEqual([...runtimeConfig.allowedRoots], [], 'no roots means the whole filesystem');
  assert.equal(runtimeConfig.dangerousCommands, 'allow');

  const read = await invokeTool('read_file', { path: join(outside, 'secret.txt') });
  assert.equal(isError(read), false, body(read));
  assert.match(body(read), /readable only when the confinement is off/);

  // A command the blocklist and the catastrophic guardrail would both refuse now runs.
  const command = await invokeTool('start_process', { command: process.platform === 'win32' ? 'echo godmode' : 'echo godmode', timeout_ms: 5000 });
  assert.equal(isError(command), false, body(command));
});

test('the switch stays out of reach for a model', async () => {
  // Neither the settable set nor the tool that writes it may mention it: a model that could widen its
  // own reach would turn prompt injection into root.
  assert.equal(settableKeys.includes('unrestricted'), false);
  const attempt = await invokeTool('set_config_value', { key: 'unrestricted', value: true });
  assert.equal(isError(attempt), true);
  assert.match(body(attempt), /Unsupported setting/);
  assert.match(body(attempt), /changed by the person at this computer/);
});

test('the runtime reports the mode so the workspace and the model can say it out loud', async () => {
  const info = JSON.parse(body(await invokeTool('get_runtime_info', {})));
  assert.equal(info.policy.unrestricted, true);
  assert.match(info.policy.unrestrictedNote, /Unrestricted mode is on/);
  assert.match(info.policy.unrestrictedNote, /remcp godmode off/);
  // The guardrail note keeps its own meaning instead of being overwritten by the mode notice.
  assert.match(info.policy.note, /Guardrails reduce accidents/);
});
