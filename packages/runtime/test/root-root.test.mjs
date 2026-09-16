import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('root-root');
// `allowedRoots: ["/"]` is a legitimate way to say "the whole filesystem"; a naive
// prefix check turned it into "//" and rejected every path on the device.
process.env.REMCP_RUNTIME_ALLOWED_ROOTS = '/';

const { invokeTool } = await import('../src/invoke.mjs');

test('an allowed root of "/" permits paths instead of rejecting everything', async () => {
  const target = join(root, 'anywhere.txt');
  writeFileSync(target, 'reachable\n');
  const read = await invokeTool('read_file', { path: target });
  assert.equal(isError(read), false, body(read));
  assert.match(body(read), /reachable/);
  assert.equal(isError(await invokeTool('list_directory', { path: root })), false);
});
