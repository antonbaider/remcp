import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, chown, copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { liveConfig, runtimeConfig } from '../config.mjs';
import { documentKind, readDocxText, readPdfText } from '../documents.mjs';
import { diffStats, unifiedDiff } from '../diff.mjs';
import { applyHunks, parseUnifiedDiff } from '../patch.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import { clampInteger, decodeText, displayPath, fail, globToRegExp, image, looksBinary, multi, pageLines, resolveSafePath, splitLines, text } from '../util.mjs';

const MAX_INLINE_FILE_BYTES = 20 * 1024 * 1024;
// An image travels base64-encoded, which costs a third more bytes, and the MCP stdio client drops
// the connection above 10 MB. 4 MiB of image is ~5.4 MiB on the wire, which leaves room for the
// summary text and the frame overhead; anything larger goes through read_binary in chunks instead.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_CHUNK_BYTES = 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'], ['.avif', 'image/avif'],
]);

function detectEol(content) {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

// Only regular files can be read: a FIFO blocks until a writer appears, a device node can be
// endless, and both would hang or flood a tool call instead of returning an answer.
function assertRegularFile(info, absolute) {
  if (info.isDirectory()) fail(`${displayPath(absolute)} is a directory, not a file`);
  if (!info.isFile()) fail(`${displayPath(absolute)} is not a regular file`);
  return info;
}

// Traversal helper for every multi-file tool. A symbolic link inside an allowed root can point
// anywhere, so links are never followed and each collected path is resolved through
// resolveSafePath again before a tool reads or writes it. `stat` follows links, which is exactly
// how a symlinked directory inside a root used to expose files outside it.
async function collectTree(root, { maxFiles = 500, skip = [] } = {}) {
  const found = [];
  const denied = [];
  const skipName = name => skip.some(entry => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry));
  async function visit(target) {
    if (found.length >= maxFiles) return;
    const info = await lstat(target).catch(() => null);
    // A symlink is skipped on purpose (it can point outside the allowed roots); that is not a denial
    // and must not be reported as one.
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) { found.push(target); return; }
    if (!info.isDirectory()) return;
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      // Reporting the skip matters: silently dropping a directory made a partial walk look complete.
      denied.push(target);
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      if (entry.isSymbolicLink() || skipName(entry.name)) continue;
      await visit(path.join(target, entry.name));
    }
  }
  await visit(root);
  return { files: found, denied };
}

// Every path a multi-file tool is about to touch passes through the same confinement check as a
// single-file call, so dropping the traversal shortcut cannot widen what is reachable.
async function confineAll(paths) {
  const safe = [];
  for (const target of paths) {
    try { safe.push(await resolveSafePath(target)); } catch { /* outside the allowed roots: skip it */ }
  }
  return safe;
}

async function readTextFile(absolute) {
  const info = await stat(absolute).catch(() => fail(`File not found: ${displayPath(absolute)}`));
  assertRegularFile(info, absolute);
  if (info.size > MAX_INLINE_FILE_BYTES) fail(`File is too large to read inline (${info.size} bytes)`);
  const buffer = await readFile(absolute);
  const decoded = decodeText(buffer);
  if (decoded.encoding === 'utf8' && looksBinary(buffer)) {
    fail(`${displayPath(absolute)} looks like a binary file and cannot be read as text. Use read_image for images, or get_file_info and hash_file for other binaries.`);
  }
  return { info, content: decoded.text, encoding: decoded.encoding, eol: detectEol(decoded.text) };
}

export async function readFileTool(args) {
  const absolute = await resolveSafePath(args.path);
  // Documents first: a .docx or .pdf is not text, and the binary guard below would refuse it.
  const kind = documentKind(absolute);
  if (kind) {
    const info = await stat(absolute);
    assertRegularFile(info, absolute);
    if (info.size > MAX_INLINE_FILE_BYTES) fail(`File is too large to read inline (${info.size} bytes)`);
    const buffer = await readFile(absolute);
    const extracted = kind === 'docx' ? readDocxText(buffer) : readPdfText(buffer);
    const documentLines = splitLines(extracted);
    const offset = Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0;
    const length = clampInteger(args.length, liveConfig('maxReadLines'), 1, 10000);
    const page = pageLines(documentLines, offset, length);
    const label = kind === 'docx' ? 'Word document' : 'PDF text';
    const header = documentLines.length
      ? `${displayPath(absolute)} (${label}, lines ${page.start + 1}-${page.end} of ${documentLines.length})`
      : `${displayPath(absolute)} (${label}, no text)`;
    return text(`${header}
${page.slice.join('\n')}`);
  }
  const { content, encoding, eol } = await readTextFile(absolute);
  const lines = splitLines(content);
  const offset = Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0;
  const length = clampInteger(args.length, liveConfig('maxReadLines'), 1, 10000);
  const { start, end, slice } = pageLines(lines, offset, length);
  const notes = `${encoding === 'utf8' ? '' : ` ${encoding}`}${eol === '\r\n' ? ' CRLF' : ''}`;
  const header = lines.length
    ? `${displayPath(absolute)} (lines ${start + 1}-${end} of ${lines.length}${notes})`
    : `${displayPath(absolute)} (empty file)`;
  return text(`${header}\n${slice.join('\n')}`);
}

export async function readMultipleFilesTool(args) {
  if (!Array.isArray(args.paths) || !args.paths.length) fail('paths must be a non-empty array');
  if (args.paths.length > 50) fail('paths accepts at most 50 entries per call');
  const sections = [];
  for (const entry of args.paths) {
    let absolute;
    try {
      absolute = await resolveSafePath(entry, 'paths[]');
    } catch (error) {
      sections.push(`${String(entry)}: error - ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      const { content } = await readTextFile(absolute);
      const lines = splitLines(content);
      const limit = liveConfig('maxReadLines');
      const slice = lines.slice(0, limit);
      const suffix = lines.length > limit ? `\n… ${lines.length - limit} more lines truncated` : '';
      sections.push(`${displayPath(absolute)}:\n${slice.join('\n')}${suffix}`);
    } catch (error) {
      sections.push(`${displayPath(absolute)}: error - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return text(sections.join('\n\n'));
}

export async function readImageTool(args) {
  const absolute = await resolveSafePath(args.path);
  const info = assertRegularFile(await stat(absolute).catch(() => fail(`File not found: ${displayPath(absolute)}`)), absolute);
  if (info.size > MAX_IMAGE_BYTES) fail(`Image is ${info.size} bytes, above the ${MAX_IMAGE_BYTES}-byte inline limit`);
  const mimeType = IMAGE_TYPES.get(path.extname(absolute).toLowerCase());
  if (!mimeType) fail(`${displayPath(absolute)} is not a supported image type (${[...IMAGE_TYPES.keys()].join(', ')})`);
  if (mimeType === 'image/svg+xml') {
    const { content } = await readTextFile(absolute);
    return text(`SVG image ${displayPath(absolute)} (${info.size} bytes):\n${content}`);
  }
  const buffer = await readFile(absolute);
  return multi([
    { type: 'text', text: `${displayPath(absolute)} — ${mimeType}, ${info.size} bytes` },
    image(buffer.toString('base64'), mimeType),
  ]);
}

export async function hashFileTool(args) {
  const absolute = await resolveSafePath(args.path);
  const info = assertRegularFile(await stat(absolute).catch(() => fail(`File not found: ${displayPath(absolute)}`)), absolute);
  const algorithm = String(args.algorithm || 'sha256').toLowerCase();
  if (!['sha256', 'sha1', 'md5'].includes(algorithm)) fail('algorithm must be sha256, sha1, or md5');
  const hash = createHash(algorithm);
  await pipeline(createReadStream(absolute), hash);
  return text(`${algorithm} ${hash.digest('hex')}  ${displayPath(absolute)} (${info.size} bytes)`);
}

async function listEntry(base, depth, maxDepth, prefix, pattern) {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    // One unreadable subdirectory must not abort the whole listing.
    return [`${prefix}[DENIED] ${path.basename(base)} (${error instanceof Error ? error.code || error.message : 'unreadable'})`];
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const rows = [];
  for (const entry of entries) {
    const child = path.join(base, entry.name);
    if (entry.isDirectory()) {
      rows.push(`${prefix}[DIR] ${entry.name}`);
      if (depth < maxDepth) rows.push(...await listEntry(child, depth + 1, maxDepth, `${prefix}  `.replace(/ {2}$/, '') + '  ', pattern));
    } else if (entry.isSymbolicLink()) {
      rows.push(`${prefix}[LINK] ${entry.name}`);
    } else {
      if (pattern && !pattern.test(entry.name)) continue;
      const info = await stat(child).catch(() => null);
      rows.push(`${prefix}[FILE] ${entry.name}${info ? ` (${info.size} bytes)` : ''}`);
    }
  }
  return rows;
}

export async function listDirectoryTool(args) {
  const absolute = await resolveSafePath(args.path);
  const info = await stat(absolute).catch(() => fail(`Path not found: ${displayPath(absolute)}`));
  if (!info.isDirectory()) fail(`${displayPath(absolute)} is not a directory`);
  const depth = clampInteger(args.depth, 1, 1, 5);
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? globToRegExp(args.pattern.trim()) : null;
  const rows = await listEntry(absolute, 1, depth, '', pattern);
  return text(`${displayPath(absolute)}${pattern ? ` · matching ${args.pattern}` : ''}\n${rows.join('\n') || '(empty)'}`);
}

export async function getFileInfoTool(args) {
  const absolute = await resolveSafePath(args.path);
  const info = await stat(absolute).catch(() => fail(`Path not found: ${displayPath(absolute)}`));
  const payload = {
    path: displayPath(absolute),
    type: info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'file',
    size: info.size,
    createdAt: info.birthtime.toISOString(),
    modifiedAt: info.mtime.toISOString(),
    permissions: `0${(info.mode & 0o777).toString(8)}`,
  };
  if (info.isFile() && info.size <= MAX_INLINE_FILE_BYTES) {
    const buffer = await readFile(absolute).catch(() => null);
    if (buffer) {
      const decoded = decodeText(buffer);
      if (decoded.encoding !== 'utf8') payload.encoding = decoded.encoding;
      if (decoded.encoding !== 'utf8' || !looksBinary(buffer)) {
        const lines = splitLines(decoded.text);
        payload.lineCount = lines.length;
        payload.lastLine = Math.max(0, lines.length - 1);
        payload.eol = detectEol(decoded.text) === '\r\n' ? 'CRLF' : 'LF';
      }
    }
  }
  return text(JSON.stringify(payload, null, 2));
}

function assertWritableSize(content) {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > runtimeConfig.maxWriteBytes) {
    countEvent('writeDenials');
    recordEvent('write_denied', { reason: 'size_limit' });
    fail(`Content is ${bytes} bytes, above the ${runtimeConfig.maxWriteBytes}-byte write limit for this device`);
  }
  return bytes;
}

export async function writeFileTool(args) {
  const absolute = await resolveSafePath(args.path);
  const content = typeof args.content === 'string' ? args.content : fail('content must be a string');
  const providedMode = typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim().toLowerCase() : '';
  if (providedMode && !['rewrite', 'append'].includes(providedMode)) fail('mode must be rewrite or append');
  const mode = providedMode || 'rewrite';
  const bytes = Buffer.byteLength(content, 'utf8');
  if (mode === 'rewrite') {
    assertWritableSize(content);
    if (content.includes('\0')) fail('content contains NUL bytes. For binary data pass encoding: "base64" (or use write_binary) so the file is written byte for byte.');
  } else {
    const existing = await stat(absolute).catch(() => null);
    const existingSize = existing?.isFile() ? existing.size : 0;
    if (existingSize + bytes > runtimeConfig.maxWriteBytes) {
      countEvent('writeDenials');
      recordEvent('write_denied', { reason: 'size_limit' });
      fail(`Appending ${bytes} bytes would grow ${displayPath(absolute)} to ${existingSize + bytes} bytes, above the ${runtimeConfig.maxWriteBytes}-byte write limit for this device`);
    }
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, mode === 'append' ? { encoding: 'utf8', flag: 'a' } : 'utf8');
  countEvent('bytesWritten', bytes);
  return text(`${mode === 'append' ? 'Appended' : 'Wrote'} ${bytes} bytes to ${displayPath(absolute)}.`);
}

// Binary transfer in both directions, in chunks: the relay carries MCP results, so a
// large file is read as a sequence of base64 slices and written back the same way.
export async function readBinaryTool(args) {
  const absolute = await resolveSafePath(args.path);
  const info = assertRegularFile(await stat(absolute).catch(() => fail(`File not found: ${displayPath(absolute)}`)), absolute);
  const offset = Math.max(0, Number.isFinite(Number(args.offset_bytes)) ? Math.trunc(Number(args.offset_bytes)) : 0);
  const length = clampInteger(args.length_bytes, MAX_BINARY_CHUNK_BYTES, 1, MAX_BINARY_CHUNK_BYTES);
  const start = Math.min(offset, info.size);
  const end = Math.min(info.size, start + length);
  const handle = await open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    const payload = JSON.stringify({
      path: displayPath(absolute),
      size: info.size,
      offsetBytes: start,
      lengthBytes: buffer.length,
      nextOffsetBytes: end < info.size ? end : null,
      complete: end >= info.size,
      encoding: 'base64',
      data: buffer.toString('base64'),
    });
    return text(payload);
  } finally {
    await handle.close();
  }
}

export async function writeBinaryTool(args) {
  const absolute = await resolveSafePath(args.path);
  const data = typeof args.data === 'string' ? args.data : fail('data must be a base64 string');
  const mode = String(args.mode || 'rewrite').toLowerCase();
  if (!['rewrite', 'append'].includes(mode)) fail('mode must be rewrite or append');
  let buffer;
  try {
    buffer = Buffer.from(data.replace(/\s+/g, ''), 'base64');
  } catch {
    fail('data must be valid base64');
  }
  if (buffer.length > runtimeConfig.maxWriteBytes) {
    countEvent('writeDenials');
    recordEvent('write_denied', { reason: 'size_limit' });
    fail(`Decoded content is ${buffer.length} bytes, above the ${runtimeConfig.maxWriteBytes}-byte write limit for this device`);
  }
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer, mode === 'append' ? { flag: 'a' } : undefined);
  countEvent('bytesWritten', buffer.length);
  return text(`${mode === 'append' ? 'Appended' : 'Wrote'} ${buffer.length} bytes to ${displayPath(absolute)}.`);
}

function normalizeForFuzzy(value) {
  return splitLines(value).map(line => line.replace(/[ \t]+/g, ' ').trim());
}

// Whitespace-tolerant fallback: models frequently re-indent an exact block they just
// read. Every candidate window is compared with collapsed whitespace, and the edit is
// applied only when the number of candidate windows matches expected_replacements.
function fuzzyMatchStarts(lines, target) {
  const normalized = lines.map(line => line.replace(/[ \t]+/g, ' ').trim());
  const starts = [];
  for (let start = 0; start + target.length <= normalized.length; start += 1) {
    let equal = true;
    for (let index = 0; index < target.length; index += 1) {
      if (normalized[start + index] !== target[index]) { equal = false; break; }
    }
    if (equal) starts.push(start);
  }
  return starts;
}

export async function editBlockTool(args) {
  const absolute = await resolveSafePath(args.file_path, 'file_path');
  const oldString = typeof args.old_string === 'string' ? args.old_string : fail('old_string must be a string');
  const newString = typeof args.new_string === 'string' ? args.new_string : fail('new_string must be a string');
  if (!oldString) fail('old_string must not be empty');
  if (oldString === newString) fail('old_string and new_string are identical');
  const allowFuzzy = args.allow_fuzzy !== false;
  const dryRun = args.dry_run === true;
  const expected = Number.isInteger(Number(args.expected_replacements)) ? Math.max(1, Math.trunc(Number(args.expected_replacements))) : 1;
  const { content, eol } = await readTextFile(absolute);
  const occurrences = content.split(oldString).length - 1;

  const present = (updated, how) => {
    const stats = diffStats(content, updated);
    const summary = `${how} in ${displayPath(absolute)} (+${stats.added}/-${stats.removed} lines)`;
    if (!dryRun) return `${summary}.`;
    return `${summary}\n(dry run: nothing was written)\n${unifiedDiff(content, updated, { oldLabel: displayPath(absolute), newLabel: 'after' })}`;
  };

  if (occurrences === expected) {
    const updated = content.split(oldString).join(newString);
    assertWritableSize(updated);
    if (!dryRun) await writeFile(absolute, updated, 'utf8');
    return text(present(updated, `Replaced ${occurrences} occurrence(s)`));
  }
  if (occurrences > 0) {
    fail(`Expected ${expected} occurrence(s) of old_string but found ${occurrences}. Add more surrounding context.`);
  }
  if (!allowFuzzy) fail('old_string was not found in the file');
  const target = normalizeForFuzzy(oldString);
  const lines = splitLines(content);
  const starts = target.length ? fuzzyMatchStarts(lines, target) : [];
  if (starts.length !== expected) {
    fail(starts.length
      ? `old_string matched ${starts.length} block(s) after whitespace normalization, expected ${expected}. Add more surrounding context.`
      : 'old_string was not found in the file, even after whitespace normalization');
  }
  const replacement = splitLines(newString);
  const endsWithNewline = /\n$/.test(content);
  for (const start of [...starts].reverse()) lines.splice(start, target.length, ...replacement);
  // Rebuild with the file's own line ending: hard-coding \n silently rewrote every CRLF
  // file to LF and turned a one-line change into a whole-file diff on Windows.
  const updated = `${lines.join(eol)}${endsWithNewline && lines.length ? eol : ''}`;
  assertWritableSize(updated);
  if (!dryRun) await writeFile(absolute, updated, 'utf8');
  return text(present(updated, `Replaced ${starts.length} occurrence(s) using whitespace-tolerant matching (line endings kept as ${eol === '\r\n' ? 'CRLF' : 'LF'})`));
}

export async function replaceLinesTool(args) {
  const absolute = await resolveSafePath(args.path);
  const startLine = Number(args.start_line);
  const endLine = Number(args.end_line);
  if (!Number.isInteger(startLine) || startLine < 1) fail('start_line must be a positive integer (1-based)');
  if (!Number.isInteger(endLine) || endLine < startLine) fail('end_line must be an integer greater than or equal to start_line');
  const content = typeof args.content === 'string' ? args.content : fail('content must be a string');
  const dryRun = args.dry_run === true;
  const { content: original, eol } = await readTextFile(absolute);
  const lines = splitLines(original);
  if (startLine > lines.length) fail(`${displayPath(absolute)} has ${lines.length} lines; start_line ${startLine} is past the end`);
  const endsWithNewline = /\n$/.test(original);
  const replacement = splitLines(content);
  const updated = [...lines.slice(0, startLine - 1), ...replacement, ...lines.slice(Math.min(endLine, lines.length))];
  const updatedText = `${updated.join(eol)}${endsWithNewline && updated.length ? eol : ''}`;
  assertWritableSize(updatedText);
  const stats = diffStats(original, updatedText);
  const summary = `Replaced lines ${startLine}-${Math.min(endLine, lines.length)} of ${displayPath(absolute)} (+${stats.added}/-${stats.removed} lines)`;
  if (dryRun) {
    return text(`${summary}\n(dry run: nothing was written)\n${unifiedDiff(original, updatedText, { oldLabel: displayPath(absolute), newLabel: 'after' })}`);
  }
  await writeFile(absolute, updatedText, 'utf8');
  return text(`${summary}.`);
}

export async function replaceInFilesTool(args) {
  const root = await resolveSafePath(args.path);
  const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern : fail('pattern is required');
  const replacement = typeof args.replacement === 'string' ? args.replacement : fail('replacement must be a string');
  const filePattern = typeof args.filePattern === 'string' && args.filePattern.trim() ? args.filePattern.trim() : null;
  const isRegex = args.regex === true;
  // Applying is the default: the agent is expected to act, and a dry run is available
  // when a caller explicitly wants a preview.
  const dryRun = args.dry_run === true;
  const maxFiles = clampInteger(args.maxFiles, 100, 1, 500);
  let matcher = null;
  if (isRegex) {
    try { matcher = new RegExp(pattern, 'g'); } catch (error) {
      fail(`pattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const info = await stat(root).catch(() => fail(`Path not found: ${displayPath(root)}`));
  const walk = info.isFile() ? { files: [root], denied: [] } : await collectTree(root, { maxFiles, skip: ['.git', 'node_modules', '.remcp-trash*'] });
  const files = await confineAll(walk.files);
  const glob = filePattern ? globToRegExp(filePattern) : null;
  const changed = [];
  let scanned = 0;
  for (const file of files) {
    if (changed.length >= maxFiles) break;
    if (glob && !glob.test(path.basename(file))) continue;
    const fileInfo = await stat(file).catch(() => null);
    if (!fileInfo || fileInfo.size > MAX_INLINE_FILE_BYTES) continue;
    const buffer = await readFile(file).catch(() => null);
    if (!buffer) continue;
    const decoded = decodeText(buffer);
    if (decoded.encoding === 'utf8' && looksBinary(buffer)) continue;
    scanned += 1;
    const original = decoded.text;
    const count = isRegex ? (original.match(matcher) || []).length : original.split(pattern).length - 1;
    if (!count) continue;
    if (isRegex) matcher.lastIndex = 0;
    const updated = isRegex ? original.replace(matcher, replacement) : original.split(pattern).join(replacement);
    if (updated === original) continue;
    assertWritableSize(updated);
    if (!dryRun) await writeFile(file, updated, 'utf8');
    const stats = diffStats(original, updated);
    changed.push({ file: displayPath(file), replacements: count, added: stats.added, removed: stats.removed });
  }
  if (!changed.length) return text(`No matches for ${JSON.stringify(pattern)} in ${displayPath(root)} (${scanned} text files scanned).`);
  const rows = changed.map(entry => `${dryRun ? 'would change' : 'changed'} ${entry.file} · ${entry.replacements} replacement(s) · +${entry.added}/-${entry.removed} lines`);
  const header = `${dryRun ? 'Dry run' : 'Applied'}: ${changed.length} file(s), ${changed.reduce((sum, entry) => sum + entry.replacements, 0)} replacement(s)`;
  const hint = dryRun ? '\nNothing was written. Call again with dry_run: false to apply.' : '';
  return text(`${header}\n${rows.join('\n')}${hint}`);
}

export async function diffFilesTool(args) {
  const left = await resolveSafePath(args.left, 'left');
  const right = await resolveSafePath(args.right, 'right');
  const context = clampInteger(args.context_lines, 3, 0, 20);
  const a = await readTextFile(left);
  const b = await readTextFile(right);
  const diff = unifiedDiff(a.content, b.content, { oldLabel: displayPath(left), newLabel: displayPath(right), context });
  if (!diff) return text(`${displayPath(left)} and ${displayPath(right)} are identical (${a.content.length} bytes).`);
  const stats = diffStats(a.content, b.content);
  return text(`${displayPath(left)} → ${displayPath(right)} (+${stats.added}/-${stats.removed} lines)\n${diff}`);
}

function trashDirectoryFor() {
  if (process.platform === 'darwin') return path.join(os.homedir(), '.Trash');
  if (process.platform === 'win32') return null;
  return path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
}

export async function moveToTrashTool(args) {
  const source = await resolveSafePath(args.source, 'source');
  const info = await stat(source).catch(() => fail(`Path not found: ${displayPath(source)}`));
  const trash = trashDirectoryFor();
  let destination = null;
  if (trash) {
    // The trash lives outside the allowed roots, so only use it when confinement permits
    // it; otherwise fall back to a trash folder beside the file.
    try {
      await resolveSafePath(trash, 'trash');
      destination = trash;
    } catch { destination = null; }
  }
  if (!destination) destination = path.join(path.dirname(source), '.remcp-trash');
  await mkdir(destination, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = path.join(destination, `${stamp}-${path.basename(source)}`);
  let counter = 1;
  while (await access(target, constants.F_OK).then(() => true, () => false)) {
    target = path.join(destination, `${stamp}-${counter}-${path.basename(source)}`);
    counter += 1;
  }
  await rename(source, target).catch(async error => {
    if (error?.code !== 'EXDEV') throw error;
    if (info.isDirectory()) fail('Moving a directory to the trash across filesystems is not supported');
    await copyFile(source, target);
    await unlink(source);
  });
  return text(`Moved ${displayPath(source)} to ${displayPath(target)}. Restore it with move_file if this was a mistake.`);
}

export async function readFilesTool(args) {
  // Glob-first bulk read: one call fills the model's context with every file that matters
  // instead of one round trip per path.
  const root = await resolveSafePath(args.path || '.');
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern.trim() : '**/*';
  const maxFiles = clampInteger(args.max_files, 100, 1, 500);
  const maxLinesPerFile = clampInteger(args.max_lines_per_file, liveConfig('maxReadLines'), 1, 20000);
  const includeIgnored = args.include_ignored === true;
  const matcher = globToRegExp(pattern);
  const rootInfo = await stat(root).catch(() => null);
  // A file path is matched directly; a directory is walked without following links.
  const walk = rootInfo?.isFile()
    ? { files: [root], denied: [] }
    : await collectTree(root, {
      maxFiles: maxFiles + 1,
      skip: includeIgnored ? ['.remcp-trash*'] : ['node_modules', '.git', '.remcp-trash*'],
    });
  const candidates = await confineAll(walk.files);
  const matched = candidates.filter(target => {
    const relative = path.relative(root, target) || path.basename(target);
    return matcher.test(relative.split(path.sep).join('/')) || matcher.test(path.basename(target));
  });
  const files = matched.slice(0, maxFiles);
  if (!files.length) return text(`No files matched ${pattern} under ${displayPath(root)}.`);
  const sections = [];
  let skipped = 0;
  for (const file of files.slice(0, maxFiles)) {
    try {
      const { content, encoding } = await readTextFile(file);
      const lines = splitLines(content);
      const slice = lines.slice(0, maxLinesPerFile);
      const suffix = lines.length > maxLinesPerFile ? `\n… ${lines.length - maxLinesPerFile} more lines (use read_file with offset)` : '';
      sections.push(`===== ${displayPath(file)} (${lines.length} lines${encoding === 'utf8' ? '' : `, ${encoding}`}) =====\n${slice.join('\n')}${suffix}`);
    } catch (error) {
      skipped += 1;
      sections.push(`===== ${displayPath(file)} =====\n(skipped: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const notes = [];
  if (matched.length > files.length) notes.push(`showing the first ${files.length}`);
  if (skipped) notes.push(`${skipped} unreadable`);
  if (walk.denied.length) notes.push(`${walk.denied.length} unreadable director${walk.denied.length === 1 ? 'y' : 'ies'} skipped`);
  const header = `${matched.length} file(s) matched ${pattern} under ${displayPath(root)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  return text(`${header}\n\n${sections.join('\n\n')}`);
}

export async function writeFilesTool(args) {
  // Bulk write for scaffolding: one call creates or replaces many files.
  const files = Array.isArray(args.files) ? args.files : fail('files must be an array of { path, content } objects');
  if (!files.length) fail('files must not be empty');
  if (files.length > 200) fail('files accepts at most 200 entries per call');
  const results = [];
  let totalBytes = 0;
  for (const entry of files) {
    const target = typeof entry?.path === 'string' ? entry.path : null;
    if (!target) { results.push('skipped: entry without a path'); continue; }
    if (typeof entry.content !== 'string') { results.push(`skipped ${target}: content must be a string`); continue; }
    try {
      const absolute = await resolveSafePath(target);
      const content = entry.content;
      if (content.includes('\0')) throw new Error('content contains NUL bytes; use write_binary for binary data');
      const bytes = assertWritableSize(content);
      totalBytes += bytes;
      if (totalBytes > runtimeConfig.maxWriteBytes * 4) fail(`This call would write ${totalBytes} bytes, above the ${runtimeConfig.maxWriteBytes * 4}-byte batch limit`);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, entry.mode === 'append' ? { encoding: 'utf8', flag: 'a' } : 'utf8');
      results.push(`${entry.mode === 'append' ? 'appended' : 'wrote'} ${displayPath(absolute)} (${bytes} bytes)`);
    } catch (error) {
      results.push(`failed ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  countEvent('bytesWritten', totalBytes);
  const failed = results.filter(line => line.startsWith('failed') || line.startsWith('skipped')).length;
  return text(`${results.length - failed}/${results.length} file(s) written, ${totalBytes} bytes total\n${results.join('\n')}`, failed > 0);
}

export async function deletePathTool(args) {
  const absolute = await resolveSafePath(args.path);
  const info = await stat(absolute).catch(() => fail(`Path not found: ${displayPath(absolute)}`));
  if (path.dirname(absolute) === absolute) fail(`Refusing to delete the filesystem root ${displayPath(absolute)}`);
  const recursive = args.recursive !== false;
  if (info.isDirectory() && !recursive) {
    const entries = await readdir(absolute).catch(() => []);
    if (entries.length) fail(`Directory is not empty: ${displayPath(absolute)}. Pass recursive: true to delete it with its contents.`);
  }
  const entries = info.isDirectory() ? await readdir(absolute).catch(() => []) : [];
  await rm(absolute, { recursive: true, force: false });
  return text(`Deleted ${info.isDirectory() ? 'directory' : 'file'} ${displayPath(absolute)}${info.isDirectory() ? ` and its ${entries.length} top-level entr${entries.length === 1 ? 'y' : 'ies'}` : ''}.`);
}

export async function deletePathsTool(args) {
  const paths = Array.isArray(args.paths) ? args.paths : fail('paths must be an array of absolute paths');
  if (!paths.length) fail('paths must not be empty');
  if (paths.length > 500) fail('paths accepts at most 500 entries per call');
  const recursive = args.recursive !== false;
  const results = [];
  let deleted = 0;
  for (const entry of paths) {
    try {
      const absolute = await resolveSafePath(entry, 'paths[]');
      if (path.dirname(absolute) === absolute) throw new Error('refusing to delete the filesystem root');
      const info = await stat(absolute).catch(() => null);
      if (!info) throw new Error('not found');
      if (info.isDirectory() && !recursive) {
        const children = await readdir(absolute).catch(() => []);
        if (children.length) throw new Error('directory is not empty (pass recursive: true)');
      }
      await rm(absolute, { recursive: true, force: false });
      deleted += 1;
      results.push(`deleted ${displayPath(absolute)}`);
    } catch (error) {
      results.push(`failed ${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return text(`${deleted}/${paths.length} path(s) deleted\n${results.join('\n')}`, deleted !== paths.length);
}

// Recursive copy for files and whole directories, so a project or a backup can be
// duplicated in one call.
export async function copyPathsTool(args) {
  const pairs = Array.isArray(args.paths) ? args.paths : fail('paths must be an array of { source, destination } objects');
  if (!pairs.length) fail('paths must not be empty');
  if (pairs.length > 200) fail('paths accepts at most 200 entries per call');
  const overwrite = args.overwrite !== false;
  const results = [];
  let copied = 0;
  for (const entry of pairs) {
    try {
      const source = await resolveSafePath(entry?.source, 'paths[].source');
      const destination = await resolveSafePath(entry?.destination, 'paths[].destination');
      if (source === destination) throw new Error('source and destination are the same path');
      const info = await stat(source).catch(() => null);
      if (!info) throw new Error('source not found');
      const existing = await stat(destination).catch(() => null);
      if (existing && !overwrite) throw new Error('destination already exists (pass overwrite: true)');
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, force: overwrite, errorOnExist: !overwrite });
      copied += 1;
      results.push(`copied ${displayPath(source)} → ${displayPath(destination)}`);
    } catch (error) {
      results.push(`failed ${entry?.source ?? '?'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return text(`${copied}/${pairs.length} path(s) copied\n${results.join('\n')}`, copied !== pairs.length);
}

export async function movePathsTool(args) {
  const pairs = Array.isArray(args.paths) ? args.paths : fail('paths must be an array of { source, destination } objects');
  if (!pairs.length) fail('paths must not be empty');
  if (pairs.length > 200) fail('paths accepts at most 200 entries per call');
  const overwrite = args.overwrite !== false;
  const results = [];
  let moved = 0;
  for (const entry of pairs) {
    try {
      const source = await resolveSafePath(entry?.source, 'paths[].source');
      const destination = await resolveSafePath(entry?.destination, 'paths[].destination');
      if (source === destination) throw new Error('source and destination are the same path');
      const info = await stat(source).catch(() => null);
      if (!info) throw new Error('source not found');
      const existing = await stat(destination).catch(() => null);
      if (existing && !overwrite) throw new Error('destination already exists (pass overwrite: true)');
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await rename(source, destination);
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        await cp(source, destination, { recursive: true, force: overwrite, errorOnExist: !overwrite });
        await rm(source, { recursive: true, force: true });
      }
      moved += 1;
      results.push(`moved ${displayPath(source)} → ${displayPath(destination)}`);
    } catch (error) {
      results.push(`failed ${entry?.source ?? '?'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return text(`${moved}/${pairs.length} path(s) moved\n${results.join('\n')}`, moved !== pairs.length);
}

// Applying a unified diff is the fastest path from "the model knows the change" to "the
// change is on disk": no exact-block matching, no re-sending whole files.
export async function applyPatchTool(args) {
  const patch = typeof args.patch === 'string' && args.patch.trim() ? args.patch : fail('patch must be a unified diff');
  const dryRun = args.dry_run === true;
  const forcePath = typeof args.path === 'string' && args.path.trim() ? args.path : null;
  const files = parseUnifiedDiff(patch);
  if (!files.length) fail('patch does not contain any @@ hunks');
  const results = [];
  let changed = 0;
  for (const file of files) {
    const target = forcePath || (file.newPath && file.newPath !== '/dev/null' ? file.newPath : file.oldPath);
    if (!target || target === '/dev/null') { results.push('failed: a hunk has no target path; pass path explicitly'); continue; }
    try {
      const absolute = await resolveSafePath(target);
      let original = '';
      try { original = (await readTextFile(absolute)).content; } catch (error) {
        if (file.oldPath === '/dev/null' || /not found/i.test(error?.message || '')) original = '';
        else throw error;
      }
      const { updated, applied, failed } = applyHunks(original, file.hunks);
      if (failed.length && !applied.length) { results.push(`failed ${displayPath(absolute)}: none of the ${file.hunks.length} hunk(s) matched`); continue; }
      const stats = diffStats(original, updated);
      if (!dryRun) {
        assertWritableSize(updated);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, updated, 'utf8');
      }
      changed += 1;
      const fuzzy = applied.filter(entry => entry.fuzz > 0).length;
      results.push(`${dryRun ? 'would patch' : 'patched'} ${displayPath(absolute)} · ${applied.length}/${file.hunks.length} hunk(s), +${stats.added}/-${stats.removed} lines${fuzzy ? `, ${fuzzy} with fuzz` : ''}${failed.length ? `, ${failed.length} hunk(s) did not match` : ''}`);
      if (dryRun) results.push(unifiedDiff(original, updated, { oldLabel: displayPath(absolute), newLabel: 'after' }));
    } catch (error) {
      results.push(`failed ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const failedCount = results.filter(line => line.startsWith('failed')).length;
  return text([`${changed}/${files.length} file(s) ${dryRun ? 'would be patched' : 'patched'}`, ...results].join('\n'), failedCount > 0);
}

export async function setPermissionsTool(args) {
  const absolute = await resolveSafePath(args.path);
  const info = await stat(absolute).catch(() => fail(`Path not found: ${displayPath(absolute)}`));
  const raw = typeof args.mode === 'string' ? args.mode.trim() : String(args.mode ?? '');
  if (!/^[0-7]{3,4}$/.test(raw)) fail('mode must be an octal string such as "755" or "0644"');
  const mode = Number.parseInt(raw, 8);
  const recursive = args.recursive === true;
  const uid = Number.isInteger(Number(args.uid)) ? Number(args.uid) : null;
  const gid = Number.isInteger(Number(args.gid)) ? Number(args.gid) : null;
  const targets = [absolute];
  if (recursive) {
    // Directories are included, links are not: chmod follows a link and would change a target
    // outside the allowed roots.
    const walk = async target => {
      const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const child = path.join(target, entry.name);
        targets.push(child);
        if (entry.isDirectory()) await walk(child);
      }
    };
    await walk(absolute);
  }
  const confined = await confineAll(targets);
  let changed = 0;
  const failures = [];
  for (const target of confined) {
    try {
      await chmod(target, mode);
      if (uid !== null || gid !== null) await chown(target, uid ?? -1, gid ?? -1);
      changed += 1;
    } catch (error) {
      // One protected file must not abort a recursive change; the caller gets the full picture.
      failures.push(`${displayPath(target)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const summary = `Set mode ${raw}${uid !== null || gid !== null ? ` (uid ${uid ?? '-'} gid ${gid ?? '-'})` : ''} on ${changed} path(s) starting at ${displayPath(absolute)}.`;
  if (!failures.length) return text(summary);
  return text(`${summary}\n${failures.length} path(s) could not be changed:\n${failures.slice(0, 20).join('\n')}`, true);
}

export async function createDirectoryTool(args) {
  const list = Array.isArray(args.paths) ? args.paths : [args.path];
  if (!list.filter(Boolean).length) fail('path (or paths) is required');
  if (list.length > 200) fail('paths accepts at most 200 entries per call');
  const created = [];
  const failed = [];
  for (const entry of list) {
    try {
      const absolute = await resolveSafePath(entry);
      await mkdir(absolute, { recursive: true });
      created.push(displayPath(absolute));
    } catch (error) {
      failed.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const header = `${created.length} director${created.length === 1 ? 'y' : 'ies'} ready`;
  return text([header, ...created, ...failed.map(line => `failed ${line}`)].join('\n'), failed.length > 0);
}

async function pathExists(target) {
  try { await access(target, constants.F_OK); return true; } catch { return false; }
}

export async function moveFileTool(args) {
  const source = await resolveSafePath(args.source, 'source');
  const destination = await resolveSafePath(args.destination, 'destination');
  if (source === destination) fail('source and destination are the same path');
  await stat(source).catch(() => fail(`Source not found: ${displayPath(source)}`));
  const overwrite = args.overwrite !== false;
  const existing = await stat(destination).catch(() => null);
  if (existing && !overwrite) fail(`Destination already exists: ${displayPath(destination)}. Pass overwrite: true to replace it.`);
  if (existing?.isDirectory()) {
    const entries = await readdir(destination).catch(() => []);
    if (entries.length) fail(`Destination is a non-empty directory: ${displayPath(destination)}. Move it aside or pick another name.`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    const info = await stat(source);
    if (info.isDirectory()) fail('Moving a directory across filesystems is not supported; copy it manually or move within one volume');
    await copyFile(source, destination);
    await unlink(source);
  }
  return text(`Moved ${displayPath(source)} to ${displayPath(destination)}.`);
}

export async function copyFileTool(args) {
  const source = await resolveSafePath(args.source, 'source');
  const destination = await resolveSafePath(args.destination, 'destination');
  if (source === destination) fail('source and destination are the same path');
  const info = await stat(source).catch(() => fail(`Source not found: ${displayPath(source)}`));
  if (info.isDirectory()) fail('copy_file copies single files only; create the directory and copy its files individually');
  const overwrite = args.overwrite !== false;
  if (!overwrite && await pathExists(destination)) fail(`Destination already exists: ${displayPath(destination)}. Pass overwrite: true to replace it.`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, overwrite ? 0 : constants.COPYFILE_EXCL);
  return text(`Copied ${displayPath(source)} to ${displayPath(destination)} (${info.size} bytes).`);
}

// --- archives -------------------------------------------------------------------------
function archiveTool() {
  const probe = name => {
    const result = spawnSync(name, ['--version'], { encoding: 'utf8' });
    return !result.error && result.status === 0 ? name : null;
  };
  return { tar: probe('tar'), zip: probe('zip'), unzip: probe('unzip') };
}

export async function createArchiveTool(args) {
  const tools = archiveTool();
  const sources = Array.isArray(args.paths) ? args.paths : [args.paths].filter(Boolean);
  if (!sources.length) fail('paths must list at least one file or directory');
  const resolved = [];
  for (const entry of sources) resolved.push(await resolveSafePath(entry, 'paths[]'));
  const destination = await resolveSafePath(args.destination, 'destination');
  const format = String(args.format || (destination.endsWith('.zip') ? 'zip' : 'tar.gz')).toLowerCase();
  await mkdir(path.dirname(destination), { recursive: true });
  const baseDir = path.dirname(resolved[0]);
  const names = resolved.map(entry => path.relative(baseDir, entry));
  // An archive written inside the tree it packs makes tar abort with "file changed as we
  // read it" (the directory mtime moves while it is being read), so build it outside the
  // tree first and move it into place afterwards.
  const destinationRelative = path.relative(baseDir, destination);
  const selfInside = !destinationRelative.startsWith('..') && !path.isAbsolute(destinationRelative);
  const suffix = format === 'zip' ? '.zip' : format === 'tar' ? '.tar' : '.tar.gz';
  const staging = selfInside ? path.join(os.tmpdir(), `remcp-archive-${Date.now()}-${process.pid}${suffix}`) : destination;
  const output = staging;
  if (format === 'zip') {
    if (!tools.zip) fail('zip is not installed on this device; use format "tar.gz"');
    const result = spawnSync(tools.zip, ['-r', '-q', output, ...names], { cwd: baseDir, encoding: 'utf8' });
    if (result.status !== 0) fail(`zip failed: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
  } else if (format === 'tar' || format === 'tar.gz' || format === 'tgz') {
    if (!tools.tar) fail('tar is not installed on this device');
    const flags = format === 'tar' ? '-cf' : '-czf';
    const result = spawnSync(tools.tar, [flags, output, ...names], { cwd: baseDir, encoding: 'utf8' });
    if (result.status !== 0) fail(`tar failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  } else {
    fail('format must be tar, tar.gz, or zip');
  }
  if (selfInside) {
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(staging, destination);
  }
  const info = await stat(destination).catch(() => null);
  const note = selfInside ? ' (built outside the tree so it does not include itself)' : '';
  return text(`Created ${displayPath(destination)} (${format}, ${info?.size ?? 0} bytes) from ${resolved.length} path(s)${note}.`);
}

export async function extractArchiveTool(args) {
  const tools = archiveTool();
  const archive = await resolveSafePath(args.archive, 'archive');
  const destination = await resolveSafePath(args.destination || path.dirname(archive), 'destination');
  await mkdir(destination, { recursive: true });
  if (/\.zip$/i.test(archive)) {
    if (!tools.unzip) fail('unzip is not installed on this device');
    const result = spawnSync(tools.unzip, ['-o', '-q', archive, '-d', destination], { encoding: 'utf8' });
    if (result.status !== 0) fail(`unzip failed: ${(result.stderr || result.stdout || '').trim() || `exit ${result.status}`}`);
  } else {
    if (!tools.tar) fail('tar is not installed on this device');
    const flags = /\.(tar\.gz|tgz)$/i.test(archive) ? '-xzf' : /\.(tar\.bz2|tbz2?)$/i.test(archive) ? '-xjf' : /\.tar\.xz$/i.test(archive) ? '-xJf' : '-xf';
    const result = spawnSync(tools.tar, [flags, archive, '-C', destination], { encoding: 'utf8' });
    if (result.status !== 0) fail(`tar failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
  const entries = await readdir(destination).catch(() => []);
  return text(`Extracted ${displayPath(archive)} into ${displayPath(destination)} (${entries.length} top-level entries).`);
}

// --- screenshots ----------------------------------------------------------------------
const SCREENSHOT_COMMANDS = [
  { command: 'grim', args: file => [file] },
  { command: 'gnome-screenshot', args: file => ['-f', file] },
  { command: 'spectacle', args: file => ['-b', '-n', '-o', file] },
  { command: 'scrot', args: file => ['-o', file] },
  { command: 'import', args: file => ['-window', 'root', file] },
  { command: 'screencapture', args: file => ['-x', file] },
];

function windowsScreenshotScript(file) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');
}

export async function takeScreenshotTool(args) {
  const directory = await resolveSafePath(args.directory || os.tmpdir(), 'directory');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `remcp-screenshot-${Date.now()}.png`);
  const attempts = [];
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsScreenshotScript(file)], { encoding: 'utf8', timeout: 30000 });
    attempts.push(`powershell: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  } else {
    for (const candidate of SCREENSHOT_COMMANDS) {
      if (spawnSync('which', [candidate.command], { encoding: 'utf8' }).status !== 0) continue;
      const result = spawnSync(candidate.command, candidate.args(file), { encoding: 'utf8', timeout: 30000 });
      if (result.status === 0 && await pathExists(file)) break;
      attempts.push(`${candidate.command}: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
    }
  }
  if (!await pathExists(file)) {
    fail(`Could not capture the screen. Install one of grim, gnome-screenshot, spectacle, scrot, or ImageMagick import (tried: ${attempts.join('; ') || 'none available'}).`);
  }
  const info = await stat(file);
  if (info.size > MAX_IMAGE_BYTES) {
    await rm(file, { force: true });
    fail(`Screenshot is ${info.size} bytes, above the ${MAX_IMAGE_BYTES}-byte inline limit`);
  }
  const buffer = await readFile(file);
  if (args.keep !== true) await rm(file, { force: true });
  return multi([
    { type: 'text', text: `Screenshot of ${os.hostname()} (${info.size} bytes)${args.keep === true ? ` saved at ${displayPath(file)}` : ''}` },
    image(buffer.toString('base64'), 'image/png'),
  ]);
}

export const fileToolHandlers = {
  read_file: readFileTool,
  read_files: readFilesTool,
  read_multiple_files: readMultipleFilesTool,
  read_image: readImageTool,
  read_binary: readBinaryTool,
  hash_file: hashFileTool,
  list_directory: listDirectoryTool,
  get_file_info: getFileInfoTool,
  write_file: writeFileTool,
  write_files: writeFilesTool,
  write_binary: writeBinaryTool,
  edit_block: editBlockTool,
  replace_lines: replaceLinesTool,
  replace_in_files: replaceInFilesTool,
  diff_files: diffFilesTool,
  create_directory: createDirectoryTool,
  apply_patch: applyPatchTool,
  set_permissions: setPermissionsTool,
  delete_path: deletePathTool,
  delete_paths: deletePathsTool,
  move_file: moveFileTool,
  move_paths: movePathsTool,
  copy_file: copyFileTool,
  copy_paths: copyPathsTool,
  move_to_trash: moveToTrashTool,
  create_archive: createArchiveTool,
  extract_archive: extractArchiveTool,
  take_screenshot: takeScreenshotTool,
};
