import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { runtimeConfig } from '../config.mjs';
import { diffStats, unifiedDiff } from '../diff.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import { clampInteger, decodeText, displayPath, fail, globToRegExp, image, looksBinary, multi, pageLines, resolveSafePath, splitLines, text } from '../util.mjs';

const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'], ['.avif', 'image/avif'],
]);

function detectEol(content) {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

async function readTextFile(absolute) {
  const info = await stat(absolute).catch(() => fail(`File not found: ${displayPath(absolute)}`));
  if (info.isDirectory()) fail(`${displayPath(absolute)} is a directory, not a file`);
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
  const { content, encoding, eol } = await readTextFile(absolute);
  const lines = splitLines(content);
  const offset = Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0;
  const length = clampInteger(args.length, runtimeConfig.maxReadLines, 1, 10000);
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
      const limit = runtimeConfig.maxReadLines;
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
  const info = await stat(absolute).catch(() => fail(`File not found: ${displayPath(absolute)}`));
  if (info.isDirectory()) fail(`${displayPath(absolute)} is a directory, not an image`);
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
  const info = await stat(absolute).catch(() => fail(`File not found: ${displayPath(absolute)}`));
  if (info.isDirectory()) fail(`${displayPath(absolute)} is a directory, not a file`);
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

function assertTextContent(content) {
  if (content.includes('\0')) {
    countEvent('writeDenials');
    recordEvent('write_denied', { reason: 'binary_content' });
    fail('content contains NUL bytes; this tool writes text files only');
  }
}

export async function writeFileTool(args) {
  const absolute = await resolveSafePath(args.path);
  const content = typeof args.content === 'string' ? args.content : fail('content must be a string');
  assertTextContent(content);
  const bytes = assertWritableSize(content);
  const providedMode = typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim().toLowerCase() : '';
  if (providedMode && !['rewrite', 'append'].includes(providedMode)) fail('mode must be rewrite or append');
  const existing = await stat(absolute).catch(() => null);
  // Replacing a non-empty file is the one call that can destroy work with no confirmation,
  // so the replacement has to be explicit. Creating and appending stay frictionless.
  if (!providedMode && existing?.isFile() && existing.size > 0) {
    countEvent('writeDenials');
    recordEvent('write_denied', { reason: 'implicit_overwrite' });
    fail(`${displayPath(absolute)} already contains ${existing.size} bytes. Pass mode: "rewrite" to replace it, mode: "append" to add to the end, or use edit_block or replace_lines to change part of it.`);
  }
  const mode = providedMode || 'rewrite';
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, mode === 'append' ? { encoding: 'utf8', flag: 'a' } : 'utf8');
  countEvent('bytesWritten', bytes);
  return text(`${mode === 'append' ? 'Appended' : 'Wrote'} ${bytes} bytes to ${displayPath(absolute)}.`);
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
  const dryRun = args.dry_run !== false; // replacing across files defaults to a preview
  const maxFiles = clampInteger(args.maxFiles, 100, 1, 500);
  let matcher = null;
  if (isRegex) {
    try { matcher = new RegExp(pattern, 'g'); } catch (error) {
      fail(`pattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const info = await stat(root).catch(() => fail(`Path not found: ${displayPath(root)}`));
  const files = [];
  async function collect(target) {
    if (files.length > maxFiles) return;
    const entryInfo = await stat(target).catch(() => null);
    if (!entryInfo) return;
    if (entryInfo.isFile()) { files.push(target); return; }
    if (!entryInfo.isDirectory()) return;
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length > maxFiles) return;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.remcp-trash')) continue;
      await collect(path.join(target, entry.name));
    }
  }
  if (info.isFile()) files.push(root);
  else await collect(root);
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

export async function createDirectoryTool(args) {
  const absolute = await resolveSafePath(args.path);
  await mkdir(absolute, { recursive: true });
  return text(`Directory ready: ${displayPath(absolute)}`);
}

async function pathExists(target) {
  try { await access(target, constants.F_OK); return true; } catch { return false; }
}

export async function moveFileTool(args) {
  const source = await resolveSafePath(args.source, 'source');
  const destination = await resolveSafePath(args.destination, 'destination');
  if (source === destination) fail('source and destination are the same path');
  await stat(source).catch(() => fail(`Source not found: ${displayPath(source)}`));
  if (await pathExists(destination)) fail(`Destination already exists: ${displayPath(destination)}. Remove it first or pick another name.`);
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
  const overwrite = args.overwrite === true;
  if (!overwrite && await pathExists(destination)) fail(`Destination already exists: ${displayPath(destination)}. Pass overwrite: true to replace it.`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, overwrite ? 0 : constants.COPYFILE_EXCL);
  return text(`Copied ${displayPath(source)} to ${displayPath(destination)} (${info.size} bytes).`);
}

export const fileToolHandlers = {
  read_file: readFileTool,
  read_multiple_files: readMultipleFilesTool,
  read_image: readImageTool,
  hash_file: hashFileTool,
  list_directory: listDirectoryTool,
  get_file_info: getFileInfoTool,
  write_file: writeFileTool,
  edit_block: editBlockTool,
  replace_lines: replaceLinesTool,
  replace_in_files: replaceInFilesTool,
  diff_files: diffFilesTool,
  create_directory: createDirectoryTool,
  move_file: moveFileTool,
  copy_file: copyFileTool,
  move_to_trash: moveToTrashTool,
};
