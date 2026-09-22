import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('policy');
const allowed = join(root, 'allowed');
mkdirSync(allowed, { recursive: true });
writeFileSync(join(allowed, 'inside.txt'), 'inside\n');
writeFileSync(join(root, 'outside.txt'), 'outside\n');
process.env.REMCP_RUNTIME_ALLOWED_ROOTS = allowed;
process.env.REMCP_RUNTIME_BLOCKED_COMMANDS = 'rm -rf /';
// Pin block explicitly so this suite exercises the blocking path independently of future
// default-policy changes.
process.env.REMCP_RUNTIME_DANGEROUS_COMMANDS = 'block';

const { invokeTool } = await import('../src/invoke.mjs');
const { describeConfig } = await import('../src/config.mjs');

test('allowed roots confine file access', async () => {
  assert.equal(isError(await invokeTool('read_file', { path: join(allowed, 'inside.txt') })), false);
  const outside = await invokeTool('read_file', { path: join(root, 'outside.txt') });
  assert.equal(isError(outside), true);
  assert.match(body(outside), /outside the directories this device allows/);
});

test('blocked commands are refused before execution', async () => {
  const result = await invokeTool('start_process', { command: 'rm -rf /', timeout_ms: 100 });
  assert.equal(isError(result), true);
  assert.match(body(result), /blocked by ReMCP device policy/);
  assert.deepEqual(describeConfig().allowedRoots, [allowed]);
});

test('the built-in guardrail stops catastrophic commands with the default configuration', async () => {
  for (const command of ['mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', 'shutdown -h now', 'echo x > /dev/sda', 'chmod -R 777 /', 'rm -rf ~']) {
    const result = await invokeTool('start_process', { command, timeout_ms: 50 });
    assert.equal(isError(result), true, `expected ${command} to be blocked`);
    assert.match(body(result), /blocked by ReMCP device policy/);
  }
});

test('ordinary commands are not blocked by the guardrail', async () => {
  const result = await invokeTool('start_process', { command: 'echo safe-guardrail-check', timeout_ms: 2000 });
  assert.equal(isError(result), false);
  assert.match(body(result), /safe-guardrail-check/);
});

test('read-only commands that merely mention a dangerous word are allowed', async () => {
  // The guardrail judges the command word of each shell segment, not every word in the line.
  for (const command of ['grep -n format /etc/hostname', 'grep -rn poweroff /etc/hostname']) {
    const result = await invokeTool('start_process', { command, timeout_ms: 2000 });
    assert.equal(isError(result), false, `expected ${command} to be allowed: ${body(result)}`);
  }
});

test('the guardrail still catches dangerous commands behind wrappers and separators', async () => {
  for (const command of ['sudo shutdown -h now', 'echo ok && mkfs.ext4 /dev/sda1', 'true; reboot', 'timeout 5 mkfs /dev/sdb']) {
    const result = await invokeTool('start_process', { command, timeout_ms: 50 });
    assert.equal(isError(result), true, `expected ${command} to be blocked`);
    assert.match(body(result), /blocked by ReMCP device policy/);
  }
});
