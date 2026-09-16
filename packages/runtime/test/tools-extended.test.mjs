import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('extended');
const { invokeTool } = await import('../src/invoke.mjs');

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('write_file refuses to replace a non-empty file without an explicit mode', async () => {
  const target = join(root, 'existing.txt');
  writeFileSync(target, 'important data\n');
  const blocked = await invokeTool('write_file', { path: target, content: 'gone\n' });
  assert.equal(isError(blocked), true);
  assert.match(body(blocked), /already contains/);
  assert.match(body(blocked), /mode: "rewrite"/);
  assert.equal(readFileSync(target, 'utf8'), 'important data\n', 'the file must be untouched');

  assert.equal(isError(await invokeTool('write_file', { path: target, content: 'replaced\n', mode: 'rewrite' })), false);
  assert.equal(readFileSync(target, 'utf8'), 'replaced\n');
  assert.equal(isError(await invokeTool('write_file', { path: target, content: 'more\n', mode: 'append' })), false);
  assert.equal(readFileSync(target, 'utf8'), 'replaced\nmore\n');
});

test('write_file still creates new files and refuses binary content', async () => {
  assert.equal(isError(await invokeTool('write_file', { path: join(root, 'fresh.txt'), content: 'new\n' })), false);
  const binary = await invokeTool('write_file', { path: join(root, 'binary.bin'), content: 'a\0b' });
  assert.equal(isError(binary), true);
  assert.match(body(binary), /NUL bytes/);
});

test('whitespace-tolerant edits keep the file line endings', async () => {
  const target = join(root, 'crlf.txt');
  writeFileSync(target, 'alpha\r\n    beta\r\ncharlie\r\n');
  const result = await invokeTool('edit_block', {
    file_path: target,
    old_string: 'alpha\n  beta\ncharlie',
    new_string: 'alpha\n  BETA\ncharlie',
  });
  assert.equal(isError(result), false);
  assert.match(body(result), /line endings kept as CRLF/);
  const updated = readFileSync(target, 'utf8');
  assert.equal(updated, 'alpha\r\n  BETA\r\ncharlie\r\n');
  assert.equal(updated.includes('\n\n'), false);
});

test('edit_block can preview a change with dry_run', async () => {
  const target = join(root, 'dryrun.txt');
  writeFileSync(target, 'one\ntwo\nthree\n');
  const preview = await invokeTool('edit_block', { file_path: target, old_string: 'two', new_string: 'TWO', dry_run: true });
  assert.equal(isError(preview), false);
  assert.match(body(preview), /dry run/);
  assert.match(body(preview), /-two/);
  assert.match(body(preview), /\+TWO/);
  assert.equal(readFileSync(target, 'utf8'), 'one\ntwo\nthree\n', 'dry_run must not write');
});

test('read_image returns an image content block and refuses non-images', async () => {
  const png = join(root, 'pixel.png');
  writeFileSync(png, TINY_PNG);
  const result = await invokeTool('read_image', { path: png });
  assert.equal(isError(result), false);
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/png');
  assert.ok(result.content[1].data.length > 10);
  const notImage = await invokeTool('read_image', { path: join(root, 'existing.txt') });
  assert.equal(isError(notImage), true);
});

test('hash_file reports a stable checksum', async () => {
  const target = join(root, 'hash.txt');
  writeFileSync(target, 'hash me\n');
  const first = body(await invokeTool('hash_file', { path: target }));
  assert.match(first, /^sha256 [0-9a-f]{64}/);
  const sha1 = body(await invokeTool('hash_file', { path: target, algorithm: 'sha1' }));
  assert.match(sha1, /^sha1 [0-9a-f]{40}/);
  assert.equal(isError(await invokeTool('hash_file', { path: target, algorithm: 'crc32' })), true);
});

test('replace_lines replaces a 1-based inclusive range and preserves the rest', async () => {
  const target = join(root, 'lines.txt');
  writeFileSync(target, 'keep-1\nold-a\nold-b\nkeep-2\n');
  const preview = body(await invokeTool('replace_lines', { path: target, start_line: 2, end_line: 3, content: 'new', dry_run: true }));
  assert.match(preview, /Replaced lines 2-3/);
  assert.match(preview, /\+new/);
  const applied = await invokeTool('replace_lines', { path: target, start_line: 2, end_line: 3, content: 'new' });
  assert.equal(isError(applied), false);
  assert.equal(readFileSync(target, 'utf8'), 'keep-1\nnew\nkeep-2\n');
  assert.equal(isError(await invokeTool('replace_lines', { path: target, start_line: 0, end_line: 1, content: 'x' })), true);
  assert.equal(isError(await invokeTool('replace_lines', { path: target, start_line: 9, end_line: 10, content: 'x' })), true);
});

test('replace_in_files previews by default and only writes when asked', async () => {
  const project = join(root, 'replace-project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.js'), 'const oldName = 1;\n');
  writeFileSync(join(project, 'src', 'b.js'), 'const other = 2;\n');
  writeFileSync(join(project, 'README.md'), 'oldName appears here too\n');

  const preview = body(await invokeTool('replace_in_files', { path: project, pattern: 'oldName', replacement: 'newName' }));
  assert.match(preview, /Dry run: 2 file\(s\)/);
  assert.match(preview, /a\.js/);
  assert.match(preview, /README\.md/);
  assert.equal(readFileSync(join(project, 'src', 'a.js'), 'utf8'), 'const oldName = 1;\n', 'preview must not write');

  const applied = body(await invokeTool('replace_in_files', { path: project, pattern: 'oldName', replacement: 'newName', dry_run: false, filePattern: '*.js' }));
  assert.match(applied, /Applied: 1 file\(s\)/);
  assert.equal(readFileSync(join(project, 'src', 'a.js'), 'utf8'), 'const newName = 1;\n');
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), 'oldName appears here too\n');

  const regex = body(await invokeTool('replace_in_files', { path: project, pattern: 'const (\\w+)', replacement: 'let $1', regex: true, dry_run: false }));
  assert.match(regex, /Applied: 2 file\(s\)/);
  assert.match(readFileSync(join(project, 'src', 'a.js'), 'utf8'), /^let newName/);
});

test('diff_files reports changes and identical files', async () => {
  const left = join(root, 'left.txt');
  const right = join(root, 'right.txt');
  writeFileSync(left, 'one\ntwo\nthree\n');
  writeFileSync(right, 'one\nTWO\nthree\n');
  const diff = body(await invokeTool('diff_files', { left, right }));
  assert.match(diff, /\+1\/-1 lines/);
  assert.match(diff, /-two/);
  assert.match(diff, /\+TWO/);
  writeFileSync(right, 'one\ntwo\nthree\n');
  assert.match(body(await invokeTool('diff_files', { left, right })), /identical/);
});

test('move_to_trash keeps the data and refuses to lose it', async () => {
  const target = join(root, 'trash-me.txt');
  writeFileSync(target, 'recoverable\n');
  const result = body(await invokeTool('move_to_trash', { source: target }));
  assert.match(result, /Moved/);
  const moved = result.match(/to (\S+)\./)[1];
  const absolute = moved.startsWith('~/') ? join(process.env.HOME, moved.slice(2)) : moved;
  assert.equal(readFileSync(absolute, 'utf8'), 'recoverable\n');
  assert.equal(isError(await invokeTool('move_to_trash', { source: target })), true);
});

test('list_directory filters by glob and survives an unreadable subdirectory', async () => {
  const base = join(root, 'listing');
  mkdirSync(join(base, 'logs'), { recursive: true });
  mkdirSync(join(base, 'locked'), { recursive: true });
  writeFileSync(join(base, 'app.log'), 'x\n');
  writeFileSync(join(base, 'app.txt'), 'x\n');
  if (process.getuid && process.getuid() !== 0) chmodSync(join(base, 'locked'), 0o000);
  try {
    const filtered = body(await invokeTool('list_directory', { path: base, pattern: '*.log' }));
    assert.match(filtered, /app\.log/);
    assert.doesNotMatch(filtered, /app\.txt/);
    const deep = body(await invokeTool('list_directory', { path: base, depth: 2 }));
    assert.match(deep, /\[DIR\] locked/);
    if (process.getuid && process.getuid() !== 0) assert.match(deep, /\[DENIED\] locked/);
  } finally {
    if (process.getuid && process.getuid() !== 0) chmodSync(join(base, 'locked'), 0o755);
  }
});

test('get_system_info reports host facts without leaking anything sensitive', async () => {
  const info = JSON.parse(body(await invokeTool('get_system_info', {})));
  assert.equal(typeof info.hostname, 'string');
  assert.ok(info.cpu.count >= 1);
  assert.ok(info.memory.totalBytes > 0);
  assert.equal(typeof info.uptimeSeconds, 'number');
  assert.match(process.version, new RegExp(`^v${info.node.replace(/\./g, '\\.')}`));
  assert.equal(statSync(root).isDirectory(), true);
});
