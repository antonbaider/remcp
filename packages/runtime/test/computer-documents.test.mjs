import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshWorkspace } from './helpers.mjs';

const root = freshWorkspace('computer-documents');
const has = command => { const r = spawnSync(command, ['--version'], { stdio: 'ignore' }); return !r.error; };
const zipReady = has('zip') && has('unzip');

function writeTree(base, files) {
  for (const [relative, value] of Object.entries(files)) {
    const target = join(base, ...relative.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, value);
  }
}

function zipTree(base, output) {
  execFileSync('zip', ['-qr', output, '.'], { cwd: base });
}

test('XLSX edit and read round-trip without a bundled spreadsheet dependency', { skip: !zipReady }, async () => {
  const sourceDir = join(root, 'xlsx-src');
  mkdirSync(sourceDir, { recursive: true });
  writeTree(sourceDir, {
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>old</t></is></c></row></sheetData></worksheet>',
  });
  const xlsx = join(root, 'book.xlsx');
  zipTree(sourceDir, xlsx);
  const { editSpreadsheet, readDocument } = await import('../src/extended/documents.mjs');
  const edited = await editSpreadsheet({ path: xlsx, edits: [
    { cell: 'A1', value: 'new' },
    { cell: 'B2', value: 42 },
    { range: 'C1:D2', values: [['c1','d1'], [3,4]] },
    { cell: 'E1', formula: '=SUM(C2:D2)' },
  ] });
  assert.equal(edited.isError, undefined);
  const read = await readDocument({ path: xlsx, sheet: 'Sheet1' });
  const parsed = JSON.parse(read.content[0].text);
  assert.deepEqual(parsed.cells.find(cell => cell.ref === 'A1')?.value, 'new');
  assert.equal(parsed.cells.find(cell => cell.ref === 'B2')?.value, 42);
  assert.equal(parsed.cells.find(cell => cell.ref === 'C1')?.value, 'c1');
  assert.equal(parsed.cells.find(cell => cell.ref === 'D2')?.value, 4);
  assert.equal(parsed.cells.find(cell => cell.ref === 'E1')?.formula, 'SUM(C2:D2)');
});

test('DOCX edit and read round-trip preserves plain paragraph text', { skip: !zipReady }, async () => {
  const sourceDir = join(root, 'docx-src');
  mkdirSync(sourceDir, { recursive: true });
  writeTree(sourceDir, {
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>',
  });
  const docx = join(root, 'note.docx');
  zipTree(sourceDir, docx);
  const { editDocument, readDocument } = await import('../src/extended/documents.mjs');
  await editDocument({ path: docx, operations: [
    { action: 'replace', search: 'world', replacement: 'ReMCP' },
    { action: 'prepend_paragraph', text: 'First paragraph' },
    { action: 'append_paragraph', text: 'Second paragraph' },
    { action: 'insert_paragraph_after', search: 'Hello ReMCP', text: 'Inserted paragraph' },
    { action: 'delete_paragraph', search: 'Second paragraph' },
  ] });
  const read = await readDocument({ path: docx });
  assert.match(read.content[0].text, /First paragraph/);
  assert.match(read.content[0].text, /Hello ReMCP/);
  assert.match(read.content[0].text, /Inserted paragraph/);
  assert.doesNotMatch(read.content[0].text, /Second paragraph/);
});

test('OOXML extraction rejects archive traversal before unzip writes anything', { skip: !zipReady }, async () => {
  const sourceDir = join(root, 'unsafe-src', 'inner');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(root, 'unsafe-src', 'escape.txt'), 'escape');
  const bad = join(sourceDir, 'unsafe.xlsx');
  execFileSync('zip', ['-q', bad, '../escape.txt'], { cwd: sourceDir });
  const { readDocument } = await import('../src/extended/documents.mjs');
  await assert.rejects(() => readDocument({ path: bad }), /unsafe path/i);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
