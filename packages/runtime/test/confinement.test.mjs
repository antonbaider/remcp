import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, freshWorkspace, isError } from './helpers.mjs';

// A symbolic link inside an allowed root must never become a way out of it. The traversal helpers
// used `stat` (which follows links) and never re-validated the children they collected, so a linked
// directory let read_files read — and replace_in_files rewrite — files outside the root.
const sandbox = freshWorkspace('symlink');
const inside = join(sandbox, 'root');
const outside = join(sandbox, 'outside');
mkdirSync(inside, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET\n');
writeFileSync(join(inside, 'kept.txt'), 'TOP SECRET inside\n');
symlinkSync(outside, join(inside, 'escape'));
process.env.REMCP_RUNTIME_ALLOWED_ROOTS = inside;

const { invokeTool } = await import('../src/invoke.mjs');

test('read_files never follows a symlink out of the allowed root', async () => {
  const result = await invokeTool('read_files', { path: inside, pattern: '**/*' });
  const text = body(result);
  assert.match(text, /kept\.txt/, 'the real file inside the root is returned');
  assert.doesNotMatch(text, /TOP SECRET\n/, 'the linked file outside the root is not read');
  assert.doesNotMatch(text, /escape\/secret\.txt|outside\/secret\.txt/, 'the linked path is not listed');
});

test('replace_in_files cannot rewrite a file outside the allowed root', async () => {
  const result = await invokeTool('replace_in_files', { path: inside, pattern: 'TOP SECRET', replacement: 'PWNED' });
  assert.equal(isError(result), false);
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'TOP SECRET\n', 'the file outside the root is untouched');
  assert.equal(readFileSync(join(inside, 'kept.txt'), 'utf8'), 'PWNED inside\n', 'the file inside the root is still rewritten');
});

test('write_file refuses a dangling final symlink', async () => {
  const link = join(inside, 'dangling');
  const outsideFile = join(outside, 'created-through-link.txt');
  symlinkSync(outsideFile, link);
  const result = await invokeTool('write_file', { path: link, content: 'PWNED' });
  assert.equal(isError(result), true);
  assert.equal(existsSync(outsideFile), false);
});

test('a direct call on a symlink outside the root is refused', async () => {
  const read = await invokeTool('read_file', { path: join(inside, 'escape', 'secret.txt') });
  assert.equal(isError(read), true, 'resolving the link lands outside the allowed roots');
  const chmod = await invokeTool('set_permissions', { path: join(inside, 'escape'), mode: '777', recursive: true });
  assert.equal(isError(chmod), true);
  assert.equal(existsSync(join(outside, 'secret.txt')), true);
});

test('move_to_trash refuses a symlinked fallback trash directory', async () => {
  const trashLink = join(inside, '.remcp-trash');
  symlinkSync(outside, trashLink);
  const source = join(inside, 'trash-source.txt');
  writeFileSync(source, 'keep me\n');
  const result = await invokeTool('move_to_trash', { source });
  assert.equal(isError(result), true);
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(join(outside, 'keep me.txt')), false);
});

test('archive creation refuses descendant symlinks instead of dereferencing them', async () => {
  const archiveRoot = join(inside, 'archive-source');
  mkdirSync(archiveRoot, { recursive: true });
  writeFileSync(join(outside, 'archive-secret.txt'), 'outside archive secret\n');
  symlinkSync(join(outside, 'archive-secret.txt'), join(archiveRoot, 'secret-link'));
  const result = await invokeTool('create_archive', { paths: [archiveRoot], destination: join(inside, 'bundle.zip'), format: 'zip' });
  assert.equal(isError(result), true);
  assert.match(body(result), /symbolic links/i);
});
