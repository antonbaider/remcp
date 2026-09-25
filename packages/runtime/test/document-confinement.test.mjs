import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { freshWorkspace } from './helpers.mjs';

const root = freshWorkspace('document-confinement');
process.env.REMCP_RUNTIME_UNRESTRICTED = '0';
process.env.REMCP_RUNTIME_ALLOWED_ROOTS = root;

const has = command => {
  const result = spawnSync(command, ['--version'], { stdio:'ignore' });
  return !result.error;
};
const zipReady = has('zip') && has('unzip');

test('read_document can read an XLSX inside allowedRoots without blocking its private staging files', { skip: !zipReady }, async () => {
  const { editSpreadsheet, readDocument } = await import('../src/extended/documents.mjs');
  const xlsx = join(root, 'book.xlsx');

  await editSpreadsheet({
    path:xlsx,
    create:true,
    sheet:'Sheet1',
    edits:[
      { cell:'A1', value:'confined' },
      { cell:'B2', value:42 },
    ],
  });

  const result = await readDocument({ path:xlsx, sheet:'Sheet1' });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.kind, 'xlsx');
  assert.equal(parsed.cells.find(cell => cell.ref === 'A1')?.value, 'confined');
  assert.equal(parsed.cells.find(cell => cell.ref === 'B2')?.value, 42);
});
