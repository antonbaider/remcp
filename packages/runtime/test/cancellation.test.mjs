import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('cancellation');
const { invokeTool } = await import('../src/invoke.mjs');
const { deletePathsTool, readFilesTool, replaceInFilesTool, writeFilesTool } = await import('../src/tools/files.mjs');

// A deterministic stand-in for AbortSignal: `aborted` flips to true once the handler has polled it
// more than `abortAfter` times. Real timing would make these tests flaky; the contract under test is
// "the handler polls the signal between items and stops at the boundary".
function countingSignal(abortAfter) {
  let polls = 0;
  return {
    get aborted() {
      polls += 1;
      return polls > abortAfter;
    },
    get polls() {
      return polls;
    },
  };
}

test('a bulk write cancelled before it starts creates nothing', async () => {
  const dir = join(root, 'pre-start');
  mkdirSync(dir, { recursive: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => writeFilesTool({ files:[{ path:join(dir, 'never.txt'), content:'nope\n' }] }, { signal:controller.signal }),
    /Cancelled by the client/,
  );
  assert.deepEqual(readdirSync(dir), [], 'a call cancelled before its first item must not write');
});

test('a bulk write stops at the item boundary and keeps what it already committed', async () => {
  const dir = join(root, 'bulk-write');
  mkdirSync(dir, { recursive: true });
  const files = [1, 2, 3, 4, 5].map(index => ({ path:join(dir, `b${index}.txt`), content:`${index}\n` }));
  const signal = countingSignal(2);
  await assert.rejects(
    () => writeFilesTool({ files }, { signal }),
    /Cancelled by the client/,
  );
  assert.deepEqual(readdirSync(dir).sort(), ['b1.txt', 'b2.txt'], 'exactly the items committed before the cancel stay');
  assert.ok(signal.polls >= 3, 'the loop must poll the signal before each item');
});

test('a bulk delete stops at the item boundary', async () => {
  const dir = join(root, 'bulk-delete');
  mkdirSync(dir, { recursive: true });
  for (const index of [1, 2, 3, 4]) writeFileSync(join(dir, `d${index}.txt`), 'x');
  const paths = [1, 2, 3, 4].map(index => join(dir, `d${index}.txt`));
  await assert.rejects(
    () => deletePathsTool({ paths }, { signal:countingSignal(1) }),
    /Cancelled by the client/,
  );
  assert.deepEqual(readdirSync(dir).sort(), ['d2.txt', 'd3.txt', 'd4.txt'], 'deletion must stop at the first poll after the cancel');
});

test('replace_in_files refuses a pre-aborted call before it touches the tree', async () => {
  const dir = join(root, 'pre-replace');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.txt'), 'alpha\n');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => replaceInFilesTool({ path:dir, pattern:'alpha', replacement:'ALPHA' }, { signal:controller.signal }),
    /Cancelled by the client/,
  );
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'alpha\n');
});

test('a cancel that lands mid-walk stops replace_in_files before the first write', async () => {
  const dir = join(root, 'mid-walk');
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 200; index += 1) writeFileSync(join(dir, `f${index}.txt`), 'needle\n');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  const result = await invokeTool(
    'replace_in_files',
    { path:dir, pattern:'needle', replacement:'haystack' },
    { signal:controller.signal },
  );
  assert.equal(isError(result), true);
  assert.match(body(result), /Cancelled by the client/);
  const rewritten = readdirSync(dir).filter(name => readFileSync(join(dir, name), 'utf8').includes('haystack'));
  assert.deepEqual(rewritten, [], 'no file may be rewritten once the client cancelled');
});

test('read_files polls the signal per file even when the call is never cancelled', async () => {
  const dir = join(root, 'bulk-read');
  mkdirSync(dir, { recursive: true });
  for (const index of [1, 2, 3]) writeFileSync(join(dir, `r${index}.txt`), 'line\n');
  const signal = countingSignal(Number.POSITIVE_INFINITY);
  const result = await readFilesTool({ path:dir, pattern:'**/*.txt' }, { signal });
  assert.match(result.content[0].text, /3 file\(s\) matched/);
  assert.ok(signal.polls >= 3, 'the read loop must consult the signal for every file');
});
