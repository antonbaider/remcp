import { splitLines } from './util.mjs';

// Compact line diff. Files routinely have a large identical prefix and suffix, so those
// are trimmed first; the remaining window is diffed with an LCS table capped at a size
// that keeps memory bounded on pathological input.

const MAX_DIFF_LINES = 4000;
const CONTEXT = 3;

function commonPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

function commonSuffix(a, b, fromStart) {
  const limit = Math.min(a.length, b.length) - fromStart;
  let count = 0;
  while (count < limit && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

function lcsOperations(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const operations = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { operations.push({ type: 'equal', line: a[i] }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { operations.push({ type: 'delete', line: a[i] }); i += 1; }
    else { operations.push({ type: 'insert', line: b[j] }); j += 1; }
  }
  while (i < a.length) { operations.push({ type: 'delete', line: a[i] }); i += 1; }
  while (j < b.length) { operations.push({ type: 'insert', line: b[j] }); j += 1; }
  return operations;
}

export function diffStats(oldText, newText) {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before, after, prefix);
  const middleBefore = before.slice(prefix, before.length - suffix);
  const middleAfter = after.slice(prefix, after.length - suffix);
  const operations = middleBefore.length > MAX_DIFF_LINES || middleAfter.length > MAX_DIFF_LINES
    ? [...middleBefore.map(line => ({ type: 'delete', line })), ...middleAfter.map(line => ({ type: 'insert', line }))]
    : lcsOperations(middleBefore, middleAfter);
  return {
    added: operations.filter(op => op.type === 'insert').length,
    removed: operations.filter(op => op.type === 'delete').length,
    truncated: middleBefore.length > MAX_DIFF_LINES || middleAfter.length > MAX_DIFF_LINES,
  };
}

export function unifiedDiff(oldText, newText, { oldLabel = 'before', newLabel = 'after', context = CONTEXT } = {}) {
  const before = splitLines(oldText);
  const after = splitLines(newText);
  if (before.join('\n') === after.join('\n')) return '';

  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before, after, prefix);
  const middleBefore = before.slice(prefix, before.length - suffix);
  const middleAfter = after.slice(prefix, after.length - suffix);
  const truncated = middleBefore.length > MAX_DIFF_LINES || middleAfter.length > MAX_DIFF_LINES;
  const operations = truncated
    ? [...middleBefore.map(line => ({ type: 'delete', line })), ...middleAfter.map(line => ({ type: 'insert', line }))]
    : lcsOperations(middleBefore, middleAfter);

  const rows = [];
  for (let index = 0; index < Math.min(prefix, context); index += 1) rows.push({ type: 'equal', line: before[prefix - Math.min(prefix, context) + index] });
  rows.push(...operations);
  for (let index = 0; index < Math.min(suffix, context); index += 1) rows.push({ type: 'equal', line: before[before.length - suffix + index] });

  const header = `--- ${oldLabel}\n+++ ${newLabel}`;
  const body = rows.map(row => `${row.type === 'insert' ? '+' : row.type === 'delete' ? '-' : ' '}${row.line}`);
  if (truncated) body.unshift('… diff truncated to the changed region (file is very large) …');
  return [header, `@@ -${prefix + 1},${middleBefore.length} +${prefix + 1},${middleAfter.length} @@`, ...body].join('\n');
}
