import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError, waitFor } from './helpers.mjs';

const root = freshWorkspace('search');
const { invokeTool } = await import('../src/invoke.mjs');

mkdirSync(join(root, 'project', 'src'), { recursive: true });
mkdirSync(join(root, 'project', 'node_modules', 'skip-me'), { recursive: true });
writeFileSync(join(root, 'project', 'src', 'alpha.js'), 'const needle = 1;\nconst other = 2;\n');
writeFileSync(join(root, 'project', 'src', 'beta.js'), 'const value = 3;\n');
writeFileSync(join(root, 'project', 'README.md'), 'needle appears in markdown\n');
writeFileSync(join(root, 'project', 'node_modules', 'skip-me', 'index.js'), 'needle should not be searched\n');

function sessionIdOf(result) {
  const match = body(result).match(/searchId: (\S+)/);
  assert.ok(match, `expected a searchId in ${body(result)}`);
  return match[1];
}

test('content search finds matches and skips node_modules', async () => {
  const result = await invokeTool('start_search', { path: join(root, 'project'), pattern: 'needle', searchType: 'content' });
  assert.equal(isError(result), false);
  const sessionId = sessionIdOf(result);
  // start_search streams: the first response can arrive before every file was scanned.
  await waitFor(async () => {
    const page = body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 100 }));
    return /status: (completed|capped|failed)/.test(page);
  });
  const output = body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 100 }));
  assert.match(output, /alpha\.js:1:/);
  assert.match(output, /README\.md:1:/);
  assert.doesNotMatch(output, /skip-me/);
});

test('content search supports globs, case folding, and pagination', async () => {
  const scoped = await invokeTool('start_search', {
    path: join(root, 'project'),
    pattern: 'NEEDLE',
    filePattern: '*.js',
    ignoreCase: true,
    maxResults: 10,
  });
  const scopedBody = body(scoped);
  assert.match(scopedBody, /alpha\.js:1:/);
  assert.doesNotMatch(scopedBody, /README\.md/);

  const sessionId = sessionIdOf(scoped);
  await waitFor(async () => totalResults(sessionId) >= 1);
  const page = body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 1 }));
  assert.match(page, /alpha\.js/);
  assert.match(page, /results 0-1 of 1/);
});

async function totalResults(sessionId) {
  const page = body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 100 }));
  const match = page.match(/results \d+-\d+ of (\d+)/);
  return match ? Number(match[1]) : 0;
}

test('files search matches globs on file names', async () => {
  const result = body(await invokeTool('start_search', { path: join(root, 'project'), pattern: '*.js', searchType: 'files' }));
  assert.match(result, /alpha\.js/);
  assert.match(result, /beta\.js/);
  assert.doesNotMatch(result, /README\.md/);
  const ignored = body(await invokeTool('start_search', { path: join(root, 'project'), pattern: '*.js', searchType: 'files', includeIgnored: true }));
  assert.match(ignored, /skip-me/);
});

test('searches can be listed, stopped, and are validated', async () => {
  const started = await invokeTool('start_search', { path: join(root, 'project'), pattern: 'const', searchType: 'content' });
  const sessionId = sessionIdOf(started);
  assert.match(body(await invokeTool('list_searches', {})), new RegExp(sessionId));
  assert.match(body(await invokeTool('stop_search', { sessionId })), /Stopped search|already/);
  assert.equal(isError(await invokeTool('get_more_search_results', { sessionId: 'search-missing' })), true);
});

test('includeHidden actually searches hidden files', async () => {
  writeFileSync(join(root, 'project', '.hidden-notes.txt'), 'hidden-needle\n');
  const without = body(await invokeTool('start_search', { path: join(root, 'project'), pattern: 'hidden-needle', searchType: 'content' }));
  assert.doesNotMatch(without, /hidden-notes/);
  const withHidden = body(await invokeTool('start_search', { path: join(root, 'project'), pattern: 'hidden-needle', searchType: 'content', includeHidden: true }));
  assert.match(withHidden, /hidden-notes\.txt/);
});

test('literalSearch reaches ripgrep instead of silently changing strategy', async () => {
  writeFileSync(join(root, 'project', 'src', 'literal.txt'), 'value = a.b\nvalue = axb\n');
  const literal = body(await invokeTool('start_search', { path: join(root, 'project'), pattern: 'a.b', searchType: 'content', literalSearch: true, filePattern: 'literal.txt' }));
  assert.match(literal, /value = a\.b/);
  assert.doesNotMatch(literal, /axb/);
});

test('an invalid regular expression is reported instead of silently downgraded', async () => {
  const result = await invokeTool('start_search', { path: join(root, 'project'), pattern: '([unclosed', searchType: 'content' });
  assert.equal(isError(result), true);
  assert.match(body(result), /not a valid regular expression/);
  assert.match(body(result), /literalSearch: true/);
});

test('a plain file-name pattern matches names that contain it', async () => {
  const result = body(await invokeTool('start_search', { path: join(root, 'project'), pattern: 'alph', searchType: 'files' }));
  assert.match(result, /alpha\.js/);
  assert.doesNotMatch(result, /beta\.js/);
});

test('filePattern supports the documented alternation form and reports capped searches', async () => {
  const result = body(await invokeTool('start_search', { path: join(root, 'project'), pattern: 'needle', searchType: 'content', filePattern: '*.js|*.md', maxResults: 1 }));
  assert.match(result, /(alpha\.js|README\.md)/);
  const sessionId = sessionIdOf(await invokeTool('start_search', { path: join(root, 'project'), pattern: 'needle', searchType: 'content', maxResults: 1 }));
  await waitFor(async () => {
    const page = body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 5 }));
    return /status: (capped|completed)/.test(page);
  });
  const final = body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 5 }));
  assert.match(final, /status: capped/);
});

test('an unreadable search path fails instead of reporting success', async () => {
  const result = await invokeTool('start_search', { path: join(root, 'project', 'does-not-exist'), pattern: 'x', searchType: 'content' });
  assert.equal(isError(result), true);
});

test('ripgrep search keeps readable matches when a descendant is unreadable', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const project = join(root, 'permission-subtree-rg');
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
    const sessionId = sessionIdOf(started);
    await waitFor(async () => {
      const page = body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 100 }));
      return /status: (completed|capped|failed)/.test(page);
    });
    const output = body(await invokeTool('get_more_search_results', { sessionId, offset: 0, length: 100 }));
    assert.match(output, /visible\.txt:1:needle-visible/);
    assert.match(output, /status: completed/);
    assert.match(output, /warning: .*Permission denied/i);
    assert.doesNotMatch(output, /status: failed/);
  } finally {
    chmodSync(blocked, 0o700);
  }
});
