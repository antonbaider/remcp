#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const goldenPath = process.argv[2] || 'submission/tool-selection-golden.json';
const resultsPath = process.argv[3];
if (!resultsPath) {
  console.error('Usage: node scripts/score-tool-selection-eval.mjs [golden.json] <results.json>');
  process.exit(2);
}
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const actualById = new Map((results.cases || []).map(row => [row.id, row]));

function normalizeCall(value) {
  if (typeof value === 'string') {
    const [tool, ...operationParts] = value.split('/');
    return { tool:String(tool || ''), ...(operationParts.length ? { operation:operationParts.join('/') } : {}) };
  }
  if (!value || typeof value !== 'object') return { tool:'' };
  return {
    tool:String(value.tool || value.name || ''),
    ...(value.operation ? { operation:String(value.operation) } : {}),
  };
}

function sameCall(expected, actual) {
  if (!expected?.tool || expected.tool !== actual?.tool) return false;
  return expected.operation ? expected.operation === actual?.operation : true;
}

function isSubsequence(expected, actual) {
  let index = 0;
  for (const call of actual) {
    if (index < expected.length && sameCall(expected[index], call)) index += 1;
  }
  return index === expected.length;
}

function selectedCalls(actual) {
  if (Array.isArray(actual?.selectedCalls)) return actual.selectedCalls.map(normalizeCall);
  // Backward compatibility for old result files. Compact tool-only rows still score where the
  // golden expectation does not require an operation; operation-sensitive v2 cases intentionally
  // require selectedCalls so a correct domain with the wrong concrete operation cannot pass.
  if (Array.isArray(actual?.selectedTools)) return actual.selectedTools.map(normalizeCall);
  return [];
}

const rows = [];
for (const testCase of golden.cases || []) {
  const actual = actualById.get(testCase.id);
  const calls = selectedCalls(actual);
  const expectedCalls = (testCase.expected?.sequence || []).map(normalizeCall);
  const forbidden = (testCase.expected?.must_not_call || []).map(normalizeCall);
  const isNegative = testCase.kind === 'negative';
  const sequenceOk = isNegative ? calls.length === 0 : isSubsequence(expectedCalls, calls);
  const forbiddenOk = forbidden.every(blocked => !calls.some(call => sameCall(blocked, call)));
  const componentOk = !testCase.expected?.component || actual?.component === testCase.expected.component;
  const passed = Boolean(actual) && sequenceOk && forbiddenOk && componentOk;
  rows.push({
    id:testCase.id,
    kind:testCase.kind,
    passed,
    selectedCalls:calls,
    sequenceOk,
    forbiddenOk,
    componentOk,
    notes:String(actual?.notes || ''),
  });
}
const positive = rows.filter(row => row.kind !== 'negative');
const negative = rows.filter(row => row.kind === 'negative');
const ratio = (n,d) => d ? n / d : 1;
const summary = {
  cases:rows.length,
  recorded:rows.filter(row => actualById.has(row.id)).length,
  passed:rows.filter(row => row.passed).length,
  positiveRecall:ratio(positive.filter(row => row.passed).length, positive.length),
  negativePrecision:ratio(negative.filter(row => row.passed).length, negative.length),
  overallAccuracy:ratio(rows.filter(row => row.passed).length, rows.length),
};
console.log(JSON.stringify({ summary, cases:rows }, null, 2));
process.exitCode = summary.recorded === summary.cases && summary.passed === summary.cases ? 0 : 1;
