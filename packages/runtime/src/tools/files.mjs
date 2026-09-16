import path from 'node:path';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { runtimeConfig } from '../config.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import { clampInteger, displayPath, fail, looksBinary, pageLines, resolveSafePath, splitLines, text } from '../util.mjs';

const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;

async function readTextFile(absolute) {
  const info = await stat(absolute).catch(() => fail(`File not found: ${displayPath(absolute)}`));
  if (info.isDirectory()) fail(`${displayPath(absolute)} is a directory, not a file`);
  if (info.size > MAX_INLINE_FILE_BYTES) fail(`File is too large to read inline (${info.size} bytes)`);
  const buffer = await readFile(absolute);
  if (looksBinary(buffer)) fail(`${displayPath(absolute)} looks like a binary file and cannot be read as text`);
  return { info, content: buffer.toString('utf8') };
}

export async function readFileTool(args) {
  const absolute = await resolveSafePath(args.path);
  const { content } = await readTextFile(absolute);
  const lines = splitLines(content);
  const offset = Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0;
  const length = clampInteger(args.length, runtimeConfig.maxReadLines, 1, 10000);
  const { start, end, slice } = pageLines(lines, offset, length);
  const header = lines.length ? `${displayPath(absolute)} (lines ${start + 1}-${end} of ${lines.length})` : `${displayPath(absolute)} (empty file)`;
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

async function listEntry(base, depth, maxDepth, prefix) {
  const entries = await readdir(base, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const rows = [];
  for (const entry of entries) {
    const child = path.join(base, entry.name);
    if (entry.isDirectory()) {
      rows.push(`${prefix}[DIR] ${entry.name}`);
      if (depth < maxDepth) rows.push(...await listEntry(child, depth + 1, maxDepth, `${prefix}  `.replace(/ {2}$/, '') + '  '));
    } else if (entry.isSymbolicLink()) {
      rows.push(`${prefix}[LINK] ${entry.name}`);
    } else {
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
  const rows = await listEntry(absolute, 1, depth, '');
  return text(`${displayPath(absolute)}\n${rows.join('\n') || '(empty)'}`);
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
    if (buffer && !looksBinary(buffer)) {
      const lines = splitLines(buffer.toString('utf8'));
      payload.lineCount = lines.length;
      payload.lastLine = Math.max(0, lines.length - 1);
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
  const mode = String(args.mode || 'rewrite').toLowerCase();
  if (!['rewrite', 'append'].includes(mode)) fail('mode must be rewrite or append');
  const bytes = assertWritableSize(content);
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
  const expected = Number.isInteger(Number(args.expected_replacements)) ? Math.max(1, Math.trunc(Number(args.expected_replacements))) : 1;
  const { content } = await readTextFile(absolute);
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === expected) {
    const updated = content.split(oldString).join(newString);
    assertWritableSize(updated);
    await writeFile(absolute, updated, 'utf8');
    const delta = splitLines(updated).length - splitLines(content).length;
    return text(`Replaced ${occurrences} occurrence(s) in ${displayPath(absolute)} (${delta >= 0 ? '+' : ''}${delta} lines).`);
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
  const updated = `${lines.join('\n')}${endsWithNewline && lines.length ? '\n' : ''}`;
  assertWritableSize(updated);
  await writeFile(absolute, updated, 'utf8');
  const delta = lines.length - splitLines(content).length;
  return text(`Replaced ${starts.length} occurrence(s) in ${displayPath(absolute)} using whitespace-tolerant matching (${delta >= 0 ? '+' : ''}${delta} lines). Re-read the file if exact formatting matters.`);
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
  list_directory: listDirectoryTool,
  get_file_info: getFileInfoTool,
  write_file: writeFileTool,
  edit_block: editBlockTool,
  create_directory: createDirectoryTool,
  move_file: moveFileTool,
  copy_file: copyFileTool,
};
