import { splitLines } from './util.mjs';

// Minimal unified-diff applier. Models produce `--- a/file` / `+++ b/file` patches with
// `@@ -start,count +start,count @@` hunks; applying them directly is far more reliable
// than asking a model to re-send whole files or exact blocks.

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function parseUnifiedDiff(patch) {
  const lines = String(patch).replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let current = null;
  let hunk = null;
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      current = { oldPath: line.slice(4).trim(), newPath: null, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (current) current.newPath = line.slice(4).trim();
      continue;
    }
    const header = line.match(HUNK_HEADER);
    if (header) {
      if (!current) { current = { oldPath: null, newPath: null, hunks: [] }; files.push(current); }
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line === '' && hunk.lines.length === 0) continue;
    const marker = line[0];
    if (marker === ' ' || marker === '+' || marker === '-') hunk.lines.push({ type: marker, text: line.slice(1) });
  }
  return files.filter(file => file.hunks.length);
}

function normalize(line) {
  return String(line).replace(/[ \t]+/g, ' ').trim();
}

// Find the block a hunk expects, allowing for a few lines of drift and for whitespace
// differences, the same way patch(1) does with fuzz.
function locate(lines, hunk) {
  const expected = hunk.lines.filter(entry => entry.type !== '+').map(entry => entry.text);
  if (!expected.length) return { index: hunk.oldStart - 1, fuzz: 0 };
  const candidates = [];
  const anchor = Math.max(0, hunk.oldStart - 1);
  for (let offset = 0; offset <= 200; offset += 1) {
    for (const index of offset === 0 ? [anchor] : [anchor - offset, anchor + offset]) {
      if (index < 0 || index + expected.length > lines.length) continue;
      const window = lines.slice(index, index + expected.length);
      if (window.every((line, position) => line === expected[position])) candidates.push({ index, fuzz: offset });
      else if (window.every((line, position) => normalize(line) === normalize(expected[position]))) candidates.push({ index, fuzz: offset + 1000 });
    }
    if (candidates.length) break;
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.fuzz - b.fuzz || a.index - b.index);
  return candidates[0];
}

export function applyHunks(content, hunks) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = /\n$/.test(content);
  const lines = splitLines(content);
  const applied = [];
  const failed = [];
  // Apply from the bottom of the file upwards so earlier hunks keep their line numbers.
  const ordered = [...hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const hunk of ordered) {
    const found = locate(lines, hunk);
    if (!found) { failed.push(hunk); continue; }
    let cursor = found.index;
    const replacement = [];
    for (const entry of hunk.lines) {
      if (entry.type === ' ') { replacement.push(lines[cursor]); cursor += 1; continue; }
      if (entry.type === '-') { cursor += 1; continue; }
      replacement.push(entry.text);
    }
    lines.splice(found.index, cursor - found.index, ...replacement);
    applied.push({ hunk, fuzz: found.fuzz });
  }
  const updated = `${lines.join(eol)}${endsWithNewline && lines.length ? eol : ''}`;
  return { updated, applied, failed };
}
