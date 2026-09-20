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

function isSubsequence(expected, actual) {
  let index = 0;
  for (const name of actual) if (name === expected[index]) index += 1;
  return index === expected.length;
}
const rows = [];
for (const testCase of golden.cases || []) {
  const actual = actualById.get(testCase.id);
  const selectedTools = Array.isArray(actual?.selectedTools) ? actual.selectedTools.map(String) : [];
  const expectedTools = testCase.expected?.sequence || [];
  const forbidden = testCase.expected?.must_not_call || [];
  const isNegative = testCase.kind === 'negative';
  const sequenceOk = isNegative ? selectedTools.length === 0 : isSubsequence(expectedTools, selectedTools);
  const forbiddenOk = forbidden.every(name => !selectedTools.includes(name));
  const componentOk = !testCase.expected?.component || actual?.component === testCase.expected.component;
  const passed = Boolean(actual) && sequenceOk && forbiddenOk && componentOk;
  rows.push({
    id:testCase.id,
    kind:testCase.kind,
    passed,
    selectedTools,
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
