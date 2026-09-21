import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError, waitFor } from './helpers.mjs';

// CI runs on machines without ripgrep, and a user's machine may run without it too. This
// file exercises the dependency-free scanner explicitly instead of relying on whatever the
// host happens to have installed.
const root = freshWorkspace('search-fallback');
process.env.REMCP_RUNTIME_FORCE_FALLBACK = '1';

mkdirSync(join(root, 'project', 'src'), { recursive: true });
mkdirSync(join(root, 'project', 'node_modules', 'skip-me'), { recursive: true });
writeFileSync(join(root, 'project', 'src', 'Alpha.js'), 'const NEEDLE = 1;\nconst other = 2;\n');
writeFileSync(join(root, 'project', 'README.md'), 'needle appears in markdown\n');
writeFileSync(join(root, 'project', 'node_modules', 'skip-me', 'index.js'), 'needle should not be searched\n');
writeFileSync(join(root, 'project', '.hidden.txt'), 'needle in a hidden file\n');

const { invokeTool } = await import('../src/invoke.mjs');

function sessionIdOf(result) {
  const match = body(result).match(/searchId: (\S+)/);
  assert.ok(match, `expected a searchId in ${body(result)}`);
  return match[1];
}

async function finalResults(sessionId) {
  await waitFor(async () => /status: (completed|capped|failed)/.test(body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 100 }))));
  return body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 100 }));
}

test('the fallback scanner folds case when asked', async () => {
  const started = await invokeTool('start_search', { path: join(root, 'project'), pattern: 'needle', searchType: 'content', ignoreCase: true });
  const output = await finalResults(sessionIdOf(started));
  assert.match(output, /Alpha\.js:1:/, 'case-insensitive match must find NEEDLE');
  assert.match(output, /README\.md:1:/);
  assert.doesNotMatch(output, /skip-me/, 'node_modules stays excluded');

  const sensitive = await invokeTool('start_search', { path: join(root, 'project'), pattern: 'needle', searchType: 'content' });
  const sensitiveOutput = await finalResults(sessionIdOf(sensitive));
  assert.doesNotMatch(sensitiveOutput, /Alpha\.js/, 'without ignoreCase the uppercase match must not appear');
  assert.match(sensitiveOutput, /README\.md/);
});

test('the fallback scanner honours includeHidden and filePattern alternation', async () => {
  const started = await invokeTool('start_search', {
    path: join(root, 'project'), pattern: 'NEEDLE', searchType: 'content',
    ignoreCase: true, filePattern: '*.js|*.txt', includeHidden: true,
  });
  const output = await finalResults(sessionIdOf(started));
  assert.match(output, /Alpha\.js/);
  assert.match(output, /\.hidden\.txt/);
  assert.doesNotMatch(output, /README\.md/, 'filePattern limits the files that are searched');
});

test('the fallback scanner supports literal searches and file-name searches', async () => {
  writeFileSync(join(root, 'project', 'src', 'literal.txt'), 'value = a.b\nvalue = axb\n');
  const literal = await invokeTool('start_search', { path: join(root, 'project'), pattern: 'a.b', searchType: 'content', literalSearch: true, filePattern: 'literal.txt' });
  const literalOutput = await finalResults(sessionIdOf(literal));
  assert.match(literalOutput, /value = a\.b/);
  assert.doesNotMatch(literalOutput, /axb/);

  const files = await invokeTool('start_search', { path: join(root, 'project'), pattern: 'alph', searchType: 'files', ignoreCase: true });
  const filesOutput = await finalResults(sessionIdOf(files));
  assert.match(filesOutput, /Alpha\.js/);
});

test('the fallback scanner reports an invalid regular expression', async () => {
  const result = await invokeTool('start_search', { path: join(root, 'project'), pattern: '([unclosed', searchType: 'content' });
  assert.equal(isError(result), true);
  assert.match(body(result), /not a valid regular expression/);
});

test('the fallback scanner fails on a missing path', async () => {
  const result = await invokeTool('start_search', { path: join(root, 'project', 'nope'), pattern: 'x', searchType: 'content' });
  assert.equal(isError(result), true);
});

test('the fallback scanner skips unreadable descendants and keeps readable matches', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const project = join(root, 'permission-subtree-fallback');
  const blocked = join(project, 'blocked');
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(project, 'visible.txt'), 'needle-visible\n');
  writeFileSync(join(blocked, 'hidden.txt'), 'hidden\n');
  chmodSync(blocked, 0o000);
  try {
    const started = await invokeTool('start_search', {
      path: project,
      pattern: 'needle-visible',
      searchType: 'content',
      literalSearch: true,
    });
    const output = await finalResults(sessionIdOf(started));
    assert.match(output, /visible\.txt:1:\s*needle-visible/);
    assert.match(output, /status: completed/);
    assert.match(output, /warning: .*Permission denied/i);
    assert.doesNotMatch(output, /status: failed/);
  } finally {
    chmodSync(blocked, 0o700);
  }
});
