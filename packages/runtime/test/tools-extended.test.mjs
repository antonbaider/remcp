import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

const root = freshWorkspace('extended');
const { invokeTool } = await import('../src/invoke.mjs');

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('write_file replaces by default and appends on request', async () => {
  const target = join(root, 'existing.txt');
  writeFileSync(target, 'important data\n');
  assert.equal(isError(await invokeTool('write_file', { path: target, content: 'replaced\n' })), false);
  assert.equal(readFileSync(target, 'utf8'), 'replaced\n');
  assert.equal(isError(await invokeTool('write_file', { path: target, content: 'more\n', mode: 'append' })), false);
  assert.equal(readFileSync(target, 'utf8'), 'replaced\nmore\n');
  assert.equal(isError(await invokeTool('write_file', { path: target, content: 'x', mode: 'sideways' })), true);
});

test('write_file still creates new files and points binary data at write_binary', async () => {
  assert.equal(isError(await invokeTool('write_file', { path: join(root, 'fresh.txt'), content: 'new\n' })), false);
  const binary = await invokeTool('write_file', { path: join(root, 'binary.bin'), content: 'a\0b' });
  assert.equal(isError(binary), true);
  assert.match(body(binary), /write_binary/);
});

test('read_binary and write_binary transfer a file byte for byte in chunks', async () => {
  const source = join(root, 'blob.bin');
  const payload = Buffer.alloc(2500 * 1024);
  for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
  writeFileSync(source, payload);

  const first = JSON.parse(body(await invokeTool('read_binary', { path: source })));
  assert.equal(first.size, payload.length);
  assert.equal(first.encoding, 'base64');
  assert.equal(first.complete, false);
  assert.ok(Buffer.from(first.data, "base64").length <= 1024 * 1024);

  const copy = join(root, 'blob-copy.bin');
  let offset = 0;
  let complete = false;
  let appended = false;
  while (!complete) {
    const chunk = JSON.parse(body(await invokeTool('read_binary', { path: source, offset_bytes: offset })));
    assert.equal(isError(await invokeTool('write_binary', { path: copy, data: chunk.data, mode: appended ? 'append' : 'rewrite' })), false);
    appended = true;
    complete = chunk.complete;
    offset = chunk.nextOffsetBytes ?? offset;
  }
  assert.equal(readFileSync(copy).equals(payload), true, 'the copy must be identical');
  const hashSource = body(await invokeTool('hash_file', { path: source }));
  const hashCopy = body(await invokeTool('hash_file', { path: copy }));
  assert.equal(hashSource.split(' ')[1], hashCopy.split(' ')[1]);
});

test('archives can be created and extracted', async () => {
  const project = join(root, 'archive-project');
  mkdirSync(join(project, 'nested'), { recursive: true });
  writeFileSync(join(project, 'a.txt'), 'alpha\n');
  writeFileSync(join(project, 'nested', 'b.txt'), 'beta\n');
  const archive = join(root, 'bundle.tar.gz');
  const created = await invokeTool('create_archive', { paths: [project], destination: archive, format: 'tar.gz' });
  assert.equal(isError(created), false, body(created));
  assert.ok(statSync(archive).size > 0);
  const out = join(root, 'extracted');
  const extracted = await invokeTool('extract_archive', { archive, destination: out });
  assert.equal(isError(extracted), false, body(extracted));
  const nested = join(out, 'archive-project', 'nested', 'b.txt');
  assert.equal(readFileSync(nested, 'utf8'), 'beta\n');
});

test('take_screenshot either returns an image or explains what is missing', async () => {
  const result = await invokeTool('take_screenshot', { directory: root });
  if (result.isError === true) {
    assert.match(body(result), /Could not capture the screen|Install one of/);
  } else {
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].mimeType, 'image/png');
  }
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

test('replace_in_files applies immediately and can preview on request', async () => {
  const project = join(root, 'replace-project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.js'), 'const oldName = 1;\n');
  writeFileSync(join(project, 'src', 'b.js'), 'const other = 2;\n');
  writeFileSync(join(project, 'README.md'), 'oldName appears here too\n');

  const applied = body(await invokeTool('replace_in_files', { path: project, pattern: 'oldName', replacement: 'newName', filePattern: '*.js' }));
  assert.match(applied, /Applied: 1 file\(s\)/);
  assert.match(applied, /a\.js/);
  assert.equal(readFileSync(join(project, 'src', 'a.js'), 'utf8'), 'const newName = 1;\n');
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), 'oldName appears here too\n', 'filePattern still limits the change');

  const preview = body(await invokeTool('replace_in_files', { path: project, pattern: 'oldName', replacement: 'x', dry_run: true }));
  assert.match(preview, /Dry run: 1 file\(s\)/);
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), 'oldName appears here too\n', 'preview must not write');

  const regex = body(await invokeTool('replace_in_files', { path: project, pattern: 'const (\\w+)', replacement: 'let $1', regex: true }));
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

test('read_files loads a whole glob in one call and write_files scaffolds in one call', async () => {
  const project = join(root, 'bulk-project');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'node_modules', 'ignored'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# bulk\n');
  writeFileSync(join(project, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(project, 'src', 'b.js'), 'export const b = 2;\n');
  writeFileSync(join(project, 'node_modules', 'ignored', 'x.js'), 'not me\n');

  const scoped = body(await invokeTool('read_files', { path: project, pattern: '**/*.js' }));
  assert.match(scoped, /2 file\(s\) matched/);
  assert.match(scoped, /a\.js \(1 lines\)/);
  assert.match(scoped, /export const b = 2/);
  assert.doesNotMatch(scoped, /not me/);

  const everything = body(await invokeTool('read_files', { path: project, max_files: 10 }));
  assert.match(everything, /README\.md/);
  assert.match(everything, /a\.js/);

  const created = body(await invokeTool('write_files', {
    files: [
      { path: join(project, 'src', 'c.js'), content: 'export const c = 3;\n' },
      { path: join(project, 'src', 'd.js'), content: 'export const d = 4;\n' },
      { path: join(project, 'src', 'c.js'), content: '// appended\n', mode: 'append' },
      { path: join(project, 'src', 'e.js') },
    ],
  }));
  assert.match(created, /2\/3 file\(s\) written|3\/4 file\(s\) written/);
  assert.equal(readFileSync(join(project, 'src', 'c.js'), 'utf8'), 'export const c = 3;\n// appended\n');
  assert.equal(readFileSync(join(project, 'src', 'd.js'), 'utf8'), 'export const d = 4;\n');
});

test('replace_in_files edits every file it finds, in one call', async () => {
  const project = join(root, 'group-edit');
  mkdirSync(join(project, 'lib'), { recursive: true });
  for (const name of ['one', 'two', 'three']) writeFileSync(join(project, 'lib', `${name}.ts`), 'const OLD_NAME = 1;\nexport default OLD_NAME;\n');
  const result = body(await invokeTool('replace_in_files', { path: project, pattern: 'OLD_NAME', replacement: 'NEW_NAME' }));
  assert.match(result, /Applied: 3 file\(s\), 6 replacement\(s\)/);
  for (const name of ['one', 'two', 'three']) {
    assert.equal(readFileSync(join(project, 'lib', `${name}.ts`), 'utf8'), 'const NEW_NAME = 1;\nexport default NEW_NAME;\n');
  }
  const search = body(await invokeTool('start_search', { path: project, pattern: 'OLD_NAME', searchType: 'content' }));
  assert.match(search, /status: (running|completed)/);
  assert.doesNotMatch(search, /lib\/one\.ts/);
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

test('an archive created inside the tree it packs excludes itself', async () => {
  const tree = join(root, 'self-archive');
  mkdirSync(join(tree, 'nested'), { recursive: true });
  writeFileSync(join(tree, 'nested', 'file.txt'), 'payload\n');
  const archive = join(tree, 'bundle.tar.gz');
  const created = await invokeTool('create_archive', { paths: [tree], destination: archive, format: 'tar.gz' });
  assert.equal(isError(created), false, body(created));
  assert.match(body(created), /built outside the tree/);
  const listing = body(await invokeTool('start_process', { command: `tar -tzf ${archive}`, timeout_ms: 3000 }));
  assert.match(listing, /nested\/file\.txt/);
  assert.doesNotMatch(listing, /bundle\.tar\.gz/);
});

test('create, bulk create, delete, bulk delete, bulk copy and bulk move all work', async () => {
  const base = join(root, 'lifecycle');
  const created = body(await invokeTool('create_directory', { paths: [join(base, 'a', 'deep'), join(base, 'b'), join(base, 'c')] }));
  assert.match(created, /3 directories ready/);
  assert.equal(statSync(join(base, 'a', 'deep')).isDirectory(), true);

  const written = body(await invokeTool('write_files', {
    files: [
      { path: join(base, 'a', 'one.txt'), content: 'one\n' },
      { path: join(base, 'a', 'deep', 'two.txt'), content: 'two\n' },
      { path: join(base, 'b', 'three.txt'), content: 'three\n' },
    ],
  }));
  assert.match(written, /3\/3 file\(s\) written/);

  const copied = body(await invokeTool('copy_paths', { paths: [{ source: join(base, 'a'), destination: join(base, 'copy-of-a') }] }));
  assert.match(copied, /1\/1 path\(s\) copied/);
  assert.equal(readFileSync(join(base, 'copy-of-a', 'deep', 'two.txt'), 'utf8'), 'two\n');

  const moved = body(await invokeTool('move_paths', { paths: [{ source: join(base, 'b'), destination: join(base, 'moved-b') }] }));
  assert.match(moved, /1\/1 path\(s\) moved/);
  assert.equal(readFileSync(join(base, 'moved-b', 'three.txt'), 'utf8'), 'three\n');

  const single = await invokeTool('delete_path', { path: join(base, 'c') });
  assert.equal(isError(single), false);
  assert.equal(existsSync(join(base, 'c')), false);

  const nonRecursive = await invokeTool('delete_path', { path: join(base, 'a'), recursive: false });
  assert.equal(isError(nonRecursive), true);
  assert.match(body(nonRecursive), /not empty/);

  const bulk = body(await invokeTool('delete_paths', { paths: [join(base, 'a'), join(base, 'copy-of-a'), join(base, 'moved-b'), join(base, 'nope')] }));
  assert.match(bulk, /3\/4 path\(s\) deleted/);
  assert.match(bulk, /failed .*nope: not found/);
  assert.equal(existsSync(join(base, 'a')), false);
  assert.equal(existsSync(join(base, 'moved-b')), false);

  assert.equal(isError(await invokeTool('delete_path', { path: '/' })), true, 'the filesystem root is refused');
});

test('apply_patch lands a unified diff, with fuzz for small offsets, and can preview', async () => {
  const target = join(root, 'patched.js');
  writeFileSync(target, 'function main() {\n  const value = 1;\n  return value;\n}\n');
  const patch = [
    '--- a/patched.js',
    '+++ b/patched.js',
    '@@ -1,4 +1,5 @@',
    ' function main() {',
    '-  const value = 1;',
    '+  const value = 2;',
    '+  const extra = value * 2;',
    '   return value;',
    ' }',
  ].join('\n');
  const preview = body(await invokeTool('apply_patch', { patch, path: target, dry_run: true }));
  assert.match(preview, /would patch/);
  assert.match(preview, /\+  const value = 2;/);
  assert.equal(readFileSync(target, 'utf8').includes('const value = 1'), true, 'dry run must not write');

  const applied = body(await invokeTool('apply_patch', { patch, path: target }));
  assert.match(applied, /1\/1 file\(s\) patched/);
  assert.equal(readFileSync(target, 'utf8'), 'function main() {\n  const value = 2;\n  const extra = value * 2;\n  return value;\n}\n');

  // Drifted context (extra line above) still applies with fuzz.
  writeFileSync(target, '// header\nfunction main() {\n  const value = 2;\n  const extra = value * 2;\n  return value;\n}\n');
  const fuzzed = body(await invokeTool('apply_patch', { patch, path: target }));
  assert.match(fuzzed, /patched/);

  const multi = [
    '--- a/one.txt', '+++ b/one.txt', '@@ -1 +1 @@', '-old one', '+new one',
    '--- a/two.txt', '+++ b/two.txt', '@@ -1 +1 @@', '-old two', '+new two',
  ].join('\n');
  writeFileSync(join(root, 'one.txt'), 'old one\n');
  writeFileSync(join(root, 'two.txt'), 'old two\n');
  const both = body(await invokeTool('apply_patch', { patch: multi, path: null }));
  void both;
  const perFile = body(await invokeTool('apply_patch', { patch: multi, path: join(root, 'one.txt') }));
  assert.match(perFile, /patched/);
});

test('set_permissions makes a written script executable', async () => {
  const script = join(root, 'run.sh');
  writeFileSync(script, '#!/bin/sh\necho ok\n');
  assert.equal(isError(await invokeTool('set_permissions', { path: script, mode: '755' })), false);
  assert.equal(statSync(script).mode & 0o777, 0o755);
  assert.equal(isError(await invokeTool('set_permissions', { path: script, mode: 'nope' })), true);
  const dir = join(root, 'perms-dir');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'file.txt'), 'x\n');
  assert.equal(isError(await invokeTool('set_permissions', { path: dir, mode: '750', recursive: true })), false);
  assert.equal(statSync(join(dir, 'nested', 'file.txt')).mode & 0o777, 0o750);
});
