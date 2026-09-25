import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('hardening');
const allowed = join(root, 'allowed');
const outside = join(root, 'outside');
mkdirSync(allowed, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'top-secret\n');
writeFileSync(join(allowed, 'public.txt'), 'public\n');
symlinkSync(outside, join(allowed, 'escape-dir'));
symlinkSync(join(outside, 'secret.txt'), join(allowed, 'escape-file.txt'));

process.env.REMCP_RUNTIME_ALLOWED_ROOTS = allowed;
process.env.REMCP_RUNTIME_MAX_WRITE_BYTES = '32';

const { invokeTool } = await import('../src/invoke.mjs');

test('a symlinked directory cannot be used to escape the allowed roots', async () => {
  const result = await invokeTool('read_file', { path: join(allowed, 'escape-dir', 'secret.txt') });
  assert.equal(isError(result), true);
  assert.match(body(result), /resolves outside the directories this device allows|symbolic link/);
});

test('a symlinked file cannot be used to escape the allowed roots', async () => {
  const result = await invokeTool('read_file', { path: join(allowed, 'escape-file.txt') });
  assert.equal(isError(result), true);
  assert.match(body(result), /resolves outside the directories this device allows|symbolic link/);
});

test('symlink escapes are refused for search, write and listing too', async () => {
  const escapedDir = join(allowed, 'escape-dir');
  assert.equal(isError(await invokeTool('start_search', { path: escapedDir, pattern: 'top-secret' })), true);
  assert.equal(isError(await invokeTool('list_directory', { path: escapedDir })), true);
  assert.equal(isError(await invokeTool('write_file', { path: join(escapedDir, 'planted.txt'), content: 'x' })), true);
  assert.equal(isError(await invokeTool('create_directory', { path: join(escapedDir, 'planted') })), true);
  assert.equal(isError(await invokeTool('move_file', { source: join(allowed, 'public.txt'), destination: join(escapedDir, 'moved.txt') })), true);
});

test('paths inside the allowed roots still work', async () => {
  const read = await invokeTool('read_file', { path: join(allowed, 'public.txt') });
  assert.equal(isError(read), false);
  assert.match(body(read), /public/);
});

test('the write limit rejects oversized content instead of truncating it', async () => {
  const result = await invokeTool('write_file', { path: join(allowed, 'big.txt'), content: 'x'.repeat(64) });
  assert.equal(isError(result), true);
  assert.match(body(result), /above the 32-byte write limit/);
});

test('kill_process refuses the runtime, the hosting agent, and pid 1', async () => {
  for (const pid of [1, process.pid, process.ppid]) {
    const result = await invokeTool('kill_process', { pid });
    assert.equal(isError(result), true, `expected pid ${pid} to be protected`);
  }
});

test('tool output never leaks the full local path of a blocked escape', async () => {
  const result = await invokeTool('read_file', { path: join(allowed, 'escape-file.txt') });
  assert.doesNotMatch(body(result), /top-secret/);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'top-secret\n');
});

test('a hard link inside an allowed root warns once and still works', async t => {
  if (process.platform === 'win32') return t.skip('hard links need extra privileges on Windows');
  const target = join(allowed, 'linked.txt');
  writeFileSync(target, 'shared inode\n');
  linkSync(target, join(allowed, 'linked-again.txt'));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => { console.warn = originalWarn; });
  const read = await invokeTool('read_file', { path: target });
  assert.equal(isError(read), false, 'a hard link is a legitimate file layout and must not be refused');
  assert.match(body(read), /shared inode/);
  const aboutHardlinks = warnings.filter(line => /hard links/.test(line));
  assert.equal(aboutHardlinks.length, 1, `expected exactly one hard-link warning, got ${JSON.stringify(warnings)}`);
  assert.match(aboutHardlinks[0], /reachable from outside the allowed roots/);
  assert.equal(await invokeTool('read_file', { path: target }).then(result => isError(result)), false);
  assert.equal(warnings.filter(line => /hard links/.test(line)).length, 1, 'the same path must not warn twice');
});
