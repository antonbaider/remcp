import test from 'node:test';
import assert from 'node:assert/strict';
import { body, freshWorkspace, isError, waitFor } from './helpers.mjs';

freshWorkspace('terminal');
const { invokeTool } = await import('../src/invoke.mjs');

function pidOf(result) {
  const match = body(result).match(/Process (\d+)/);
  assert.ok(match, `expected a pid in ${body(result)}`);
  return Number(match[1]);
}

test('start_process runs a command and returns its output', async () => {
  const result = await invokeTool('start_process', { command: 'printf "hello-from-runtime\\n"', timeout_ms: 3000 });
  assert.equal(isError(result), false);
  assert.match(body(result), /hello-from-runtime/);
  assert.match(body(result), /finished with code 0/);
});

test('read_process_output returns new output and supports tail offsets', async () => {
  const started = await invokeTool('start_process', { command: 'for i in 1 2 3; do echo line-$i; sleep 0.4; done', timeout_ms: 200 });
  const pid = pidOf(started);
  await waitFor(async () => body(await invokeTool('read_process_output', { pid })).includes('line-3'), 8000);
  const tail = body(await invokeTool('read_process_output', { pid, offset: -2 }));
  assert.match(tail, /line-2/);
  assert.match(tail, /line-3/);
});

test('interact_with_process sends input and list_sessions reports the session', async () => {
  const started = await invokeTool('start_process', { command: 'node -e "process.stdin.on(\'data\', d => process.stdout.write(\'echo:\' + d.toString()))"', timeout_ms: 300 });
  const pid = pidOf(started);
  const response = body(await invokeTool('interact_with_process', { pid, input: 'ping', timeout_ms: 2000 }));
  assert.match(response, /echo:ping/);
  assert.match(body(await invokeTool('list_sessions', {})), new RegExp(`pid ${pid}`));
  assert.equal(isError(await invokeTool('force_terminate', { pid })), false);
});

test('unknown pids are rejected instead of starting new work', async () => {
  assert.equal(isError(await invokeTool('read_process_output', { pid: 999999 })), true);
  assert.equal(isError(await invokeTool('force_terminate', { pid: 999999 })), true);
  assert.equal(isError(await invokeTool('interact_with_process', { pid: 999999, input: 'x' })), true);
  assert.equal(isError(await invokeTool('wait_for_process_output', { pid: 999999, pattern: 'x' })), true);
});

test('wait_for_process_output returns as soon as the pattern appears', async () => {
  const started = await invokeTool('start_process', { command: 'sleep 0.6; echo READY-MARKER; sleep 5', timeout_ms: 100 });
  const pid = pidOf(started);
  const result = await invokeTool('wait_for_process_output', { pid, pattern: 'READY-MARKER', timeout_ms: 8000 });
  assert.equal(isError(result), false);
  assert.match(body(result), /pattern matched/);
  assert.match(body(result), /READY-MARKER/);
  await invokeTool('force_terminate', { pid });
});

test('wait_for_process_output reports a timeout without failing the call', async () => {
  const started = await invokeTool('start_process', { command: 'sleep 3', timeout_ms: 100 });
  const pid = pidOf(started);
  const result = await invokeTool('wait_for_process_output', { pid, pattern: 'NEVER-APPEARS', timeout_ms: 300 });
  assert.equal(isError(result), false);
  assert.match(body(result), /pattern not matched/);
  await invokeTool('force_terminate', { pid });
});
