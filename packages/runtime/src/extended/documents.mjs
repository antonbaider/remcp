import path from 'node:path';
import process from 'node:process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { readDocxText, readPdfText } from '../documents.mjs';
import { resolveSafePath, text } from '../util.mjs';
import {
  clamp,
  commandExists,
  escapePowerShellSingle,
  jsonResult,
  optionalString,
  removeTemp,
  requireEnum,
  runFile,
  runPowerShell,
  tempDir,
  unavailable,
} from './common.mjs';

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function xmlUnescape(value) {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const MAX_OOXML_ENTRIES = 10_000;
const MAX_OOXML_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

function safeArchiveEntry(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

async function validateZipArchive(source) {
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem;$z=[IO.Compression.ZipFile]::OpenRead('${escapePowerShellSingle(source)}');try{$count=$z.Entries.Count;$total=0;foreach($e in $z.Entries){$n=$e.FullName.Replace('\\','/');if([IO.Path]::IsPathRooted($n) -or $n.StartsWith('/') -or ($n.Split('/') -contains '..')){throw ('unsafe archive path: '+$n)};$total += $e.Length};if($count -gt ${MAX_OOXML_ENTRIES}){throw 'too many archive entries'};if($total -gt ${MAX_OOXML_UNCOMPRESSED_BYTES}){throw 'archive expands beyond the OOXML limit'};[pscustomobject]@{count=$count;total=$total}|ConvertTo-Json -Compress}finally{$z.Dispose()}`;
    await runPowerShell(script, { label:'validate OOXML archive', timeout:30_000 });
    return;
  }
  if (!commandExists('unzip')) unavailable('OOXML document editing', 'unzip is required');
  const names = await runFile('unzip', ['-Z','-1',source], { label:'inspect OOXML archive', timeout:30_000, maxBuffer:16 * 1024 * 1024 });
  const entries = names.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length > MAX_OOXML_ENTRIES) throw new Error(`OOXML archive has too many entries (${entries.length}; max ${MAX_OOXML_ENTRIES})`);
  const unsafe = entries.find(name => !safeArchiveEntry(name));
  if (unsafe) throw new Error(`OOXML archive contains an unsafe path: ${unsafe}`);
  const totals = await runFile('unzip', ['-Z','-t',source], { label:'inspect OOXML archive size', timeout:30_000 });
  const uncompressed = Number(totals.stdout.match(/(?:^|,\s)([0-9]+) bytes uncompressed/)?.[1] || 0);
  if (uncompressed > MAX_OOXML_UNCOMPRESSED_BYTES) throw new Error(`OOXML archive expands to ${uncompressed} bytes; max ${MAX_OOXML_UNCOMPRESSED_BYTES}`);
}

async function extractZip(source, destination) {
  await validateZipArchive(source);
  await mkdir(destination, { recursive:true });
  if (process.platform === 'win32') {
    await runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory('${escapePowerShellSingle(source)}','${escapePowerShellSingle(destination)}')`, { label:'extract OOXML archive', timeout:30_000 });
    return;
  }
  if (!commandExists('unzip')) unavailable('OOXML document editing', 'unzip is required');
  await runFile('unzip', ['-qq',source,'-d',destination], { label:'extract OOXML archive', timeout:30_000 });
}

async function createZip(sourceDir, destination) {
  await rm(destination, { force:true }).catch(() => {});
  if (process.platform === 'win32') {
    await runPowerShell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory('${escapePowerShellSingle(sourceDir)}','${escapePowerShellSingle(destination)}',[IO.Compression.CompressionLevel]::Optimal,$false)`, { label:'create OOXML archive', timeout:30_000 });
    return;
  }
  if (!commandExists('zip')) unavailable('OOXML document editing', 'zip is required');
  await runFile('zip', ['-qr',destination,'.'], { cwd:sourceDir, label:'create OOXML archive', timeout:30_000 });
}

function workbookSheetPath(workbookXml, relsXml, requestedName) {
  const sheets = [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"[^>]*\/?>(?:<\/sheet>)?/g)].map(match => ({ name:xmlUnescape(match[1]), rid:match[2] }));
  const sheet = requestedName ? sheets.find(item => item.name.toLowerCase() === requestedName.toLowerCase()) : sheets[0];
  if (!sheet) throw new Error(requestedName ? `Worksheet not found: ${requestedName}` : 'Workbook contains no worksheets');
  const relationships = [...relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g)].map(match => ({ id:match[1], target:match[2] }));
  const rel = relationships.find(item => item.id === sheet.rid);
  if (!rel) throw new Error(`Relationship for worksheet ${sheet.name} was not found`);
  const target = rel.target.replace(/^\//, '').replace(/\\/g, '/');
  if (!safeArchiveEntry(target)) throw new Error(`Worksheet relationship contains an unsafe path: ${target}`);
  const relative = path.posix.normalize(target.startsWith('xl/') ? target : path.posix.join('xl', target));
  if (!relative.startsWith('xl/') || relative.split('/').includes('..')) throw new Error(`Worksheet relationship escapes the workbook: ${target}`);
  return { name:sheet.name, relative };
}

function readSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(textMatch => xmlUnescape(textMatch[1])).join(''));
}

function readWorksheetCells(xml, sharedStrings, maxCells) {
  const cells = [];
  const pattern = /<c\b([^>]*)\br="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\br="([A-Z]+\d+)"([^>]*)\/>/g;
  for (const match of xml.matchAll(pattern)) {
    if (cells.length >= maxCells) break;
    const attrs = `${match[1] || match[5] || ''}${match[3] || match[7] || ''}`;
    const ref = match[2] || match[6];
    const body = match[4] || '';
    const type = attrs.match(/\bt="([^"]+)"/)?.[1] || '';
    const formula = body.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
    const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '';
    let value;
    if (type === 's') value = sharedStrings[Number(raw)] ?? raw;
    else if (type === 'inlineStr') value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => xmlUnescape(item[1])).join('');
    else if (type === 'b') value = raw === '1';
    else if (raw !== '' && Number.isFinite(Number(raw))) value = Number(raw);
    else value = xmlUnescape(raw);
    cells.push({ ref, value, ...(formula ? { formula:xmlUnescape(formula) } : {}) });
  }
  return cells;
}

async function readXlsx(filePath, args) {
  const dir = await tempDir('remcp-xlsx-read-');
  try {
    await extractZip(filePath, dir);
    const workbook = await readFile(path.join(dir,'xl','workbook.xml'),'utf8');
    const rels = await readFile(path.join(dir,'xl','_rels','workbook.xml.rels'),'utf8');
    const sheet = workbookSheetPath(workbook, rels, optionalString(args.sheet));
    const worksheet = await readFile(path.join(dir,...sheet.relative.split('/')),'utf8');
    let shared = [];
    try { shared = readSharedStrings(await readFile(path.join(dir,'xl','sharedStrings.xml'),'utf8')); } catch {}
    const cells = readWorksheetCells(worksheet, shared, clamp(args.max_cells,5000,1,50_000));
    return { kind:'xlsx', sheet:sheet.name, count:cells.length, cells };
  } finally { await removeTemp(dir); }
}

export async function readDocument(args) {
  const filePath = await resolveSafePath(args.path,'path');
  const lower = filePath.toLowerCase();
  const data = await readFile(filePath);
  if (lower.endsWith('.docx')) return text(readDocxText(data));
  if (lower.endsWith('.pdf')) return text(readPdfText(data));
  if (lower.endsWith('.xlsx')) return jsonResult(await readXlsx(filePath,args));
  if (/\.(txt|md|csv|json|xml|yaml|yml)$/i.test(lower)) return text(data.toString('utf8'));
  throw new Error('read_document supports PDF, DOCX, XLSX, TXT, Markdown, CSV, JSON, XML, YAML');
}

function cellXml(ref, value, formula) {
  if (formula != null) return `<c r="${ref}"><f>${xmlEscape(String(formula).replace(/^=/,''))}</f></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value ?? '')}</t></is></c>`;
}

function setWorksheetCell(xml, ref, value, formula) {
  if (!/^[A-Z]+[1-9]\d*$/.test(ref)) throw new Error(`Invalid cell reference: ${ref}`);
  const replacement = cellXml(ref,value,formula);
  const cellPattern = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*(?:>[\\s\\S]*?<\\/c>|\\/>)`);
  if (cellPattern.test(xml)) return xml.replace(cellPattern,replacement);
  const rowNo = ref.match(/\d+$/)[0];
  const rowPattern = new RegExp(`(<row\\b[^>]*\\br="${rowNo}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
  if (rowPattern.test(xml)) return xml.replace(rowPattern, (_match,start,body,end) => `${start}${body}${replacement}${end}`);
  if (!/<sheetData\b[^>]*>/.test(xml)) throw new Error('Worksheet XML has no sheetData');
  return xml.replace(/<\/sheetData>/, `<row r="${rowNo}">${replacement}</row></sheetData>`);
}

function columnNumber(label) {
  let value = 0;
  for (const char of String(label)) value = value * 26 + (char.charCodeAt(0) - 64);
  return value;
}

function columnLabel(number) {
  let value = Number(number), out = '';
  while (value > 0) { value -= 1; out = String.fromCharCode(65 + (value % 26)) + out; value = Math.floor(value / 26); }
  return out;
}

function cellPoint(ref) {
  const match = String(ref || '').toUpperCase().match(/^([A-Z]+)([1-9]\d*)$/);
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  return { col: columnNumber(match[1]), row: Number(match[2]) };
}

function expandSpreadsheetEdits(edits) {
  const expanded = [];
  for (const edit of edits) {
    if (edit?.cell) {
      const cell = String(edit.cell).toUpperCase(); cellPoint(cell);
      expanded.push({ cell, value:edit.value, formula:edit.formula });
      continue;
    }
    const range = String(edit?.range || '').toUpperCase();
    const match = range.match(/^([A-Z]+[1-9]\d*):([A-Z]+[1-9]\d*)$/);
    if (!match) throw new Error('Each spreadsheet edit requires cell or a range like A1:C3');
    const start = cellPoint(match[1]), end = cellPoint(match[2]);
    if (end.col < start.col || end.row < start.row) throw new Error(`Invalid range order: ${range}`);
    const rows = end.row - start.row + 1, cols = end.col - start.col + 1;
    const values = Array.isArray(edit.values) ? edit.values : null;
    if (values && (values.length !== rows || values.some(row => !Array.isArray(row) || row.length !== cols))) {
      throw new Error(`values for ${range} must be a ${rows}x${cols} matrix`);
    }
    for (let rowOffset = 0; rowOffset < rows; rowOffset += 1) {
      for (let colOffset = 0; colOffset < cols; colOffset += 1) {
        expanded.push({
          cell: `${columnLabel(start.col + colOffset)}${start.row + rowOffset}`,
          value: values ? values[rowOffset][colOffset] : edit.value,
          formula: edit.formula,
        });
        if (expanded.length > 500) throw new Error('Expanded spreadsheet edits exceed the 500-cell limit');
      }
    }
  }
  return expanded;
}

export async function editSpreadsheet(args) {
  const filePath = await resolveSafePath(args.path,'path');
  if (!filePath.toLowerCase().endsWith('.xlsx')) throw new Error('edit_spreadsheet supports .xlsx files');
  const requestedEdits = Array.isArray(args.edits) ? args.edits : [];
  if (!requestedEdits.length || requestedEdits.length > 500) throw new Error('edits must contain 1..500 cell/range edits');
  const edits = expandSpreadsheetEdits(requestedEdits);
  const output = args.output ? await resolveSafePath(args.output,'output') : filePath;
  const dir = await tempDir('remcp-xlsx-edit-');
  const tempOut = path.join(path.dirname(output), `.remcp-${Date.now()}-${path.basename(output)}`);
  try {
    await extractZip(filePath,dir);
    const workbook = await readFile(path.join(dir,'xl','workbook.xml'),'utf8');
    const rels = await readFile(path.join(dir,'xl','_rels','workbook.xml.rels'),'utf8');
    const sheet = workbookSheetPath(workbook,rels,optionalString(args.sheet));
    const worksheetPath = path.join(dir,...sheet.relative.split('/'));
    let xml = await readFile(worksheetPath,'utf8');
    for (const edit of edits) xml = setWorksheetCell(xml,String(edit.cell || '').toUpperCase(),edit.value,edit.formula);
    await writeFile(worksheetPath,xml,'utf8');
    await createZip(dir,tempOut);
    await copyFile(tempOut,output);
    return jsonResult({ path:output, sheet:sheet.name, edited_cells:edits.length, bytes:(await stat(output)).size });
  } finally {
    await rm(tempOut,{force:true}).catch(() => {});
    await removeTemp(dir);
  }
}

function paragraphText(xml) {
  return [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => xmlUnescape(match[1])).join('');
}

function replaceDocxText(documentXml, search, replacement, all) {
  let changed = 0;
  const needle = String(search);
  const xml = documentXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, paragraph => {
    if (!needle || !paragraphText(paragraph).includes(needle) || (!all && changed)) return paragraph;
    const current = paragraphText(paragraph);
    const next = all ? current.split(needle).join(String(replacement)) : current.replace(needle,String(replacement));
    if (next === current) return paragraph;
    changed += all ? current.split(needle).length - 1 : 1;
    const start = paragraph.match(/^<w:p\b[^>]*>/)?.[0] || '<w:p>';
    const pPr = paragraph.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/)?.[0] || '';
    return `${start}${pPr}<w:r><w:t xml:space="preserve">${xmlEscape(next)}</w:t></w:r></w:p>`;
  });
  return { xml, changed };
}

function docxParagraph(value) {
  return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(String(value ?? ''))}</w:t></w:r></w:p>`;
}

function insertDocxParagraphAtEnd(xml, paragraph) {
  const sect = xml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*<\/w:body>/);
  if (sect) return xml.replace(sect[0], `${paragraph}${sect[0]}`);
  return xml.replace(/<\/w:body>/, `${paragraph}</w:body>`);
}

function mutateMatchingParagraphs(xml, op) {
  const needle = optionalString(op.search);
  if (!needle) throw new Error(`${op.action} requires search`);
  const insert = docxParagraph(op.text);
  let changed = 0;
  const all = op.all !== false;
  const next = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, paragraph => {
    if (!paragraphText(paragraph).includes(needle) || (!all && changed)) return paragraph;
    changed += 1;
    if (op.action === 'delete_paragraph') return '';
    if (op.action === 'insert_paragraph_before') return `${insert}${paragraph}`;
    if (op.action === 'insert_paragraph_after') return `${paragraph}${insert}`;
    return paragraph;
  });
  return { xml: next, changed };
}

export async function editDocument(args) {
  const filePath = await resolveSafePath(args.path,'path');
  if (!filePath.toLowerCase().endsWith('.docx')) throw new Error('edit_document supports .docx files');
  const operations = Array.isArray(args.operations) ? args.operations : [];
  if (!operations.length || operations.length > 100) throw new Error('operations must contain 1..100 edits');
  const output = args.output ? await resolveSafePath(args.output,'output') : filePath;
  const dir = await tempDir('remcp-docx-edit-');
  const tempOut = path.join(path.dirname(output), `.remcp-${Date.now()}-${path.basename(output)}`);
  let changes = 0;
  try {
    await extractZip(filePath,dir);
    const documentPath = path.join(dir,'word','document.xml');
    let xml = await readFile(documentPath,'utf8');
    for (const op of operations) {
      const action = requireEnum(op.action,'operation.action',['replace','append_paragraph','prepend_paragraph','insert_paragraph_before','insert_paragraph_after','delete_paragraph']);
      if (action === 'replace') {
        const search = optionalString(op.search); if (!search) throw new Error('replace requires search');
        const result = replaceDocxText(xml,search,String(op.replacement ?? ''),op.all !== false);
        xml = result.xml; changes += result.changed;
      } else if (action === 'append_paragraph') {
        xml = insertDocxParagraphAtEnd(xml, docxParagraph(op.text)); changes += 1;
      } else if (action === 'prepend_paragraph') {
        xml = xml.replace(/(<w:body\b[^>]*>)/, `$1${docxParagraph(op.text)}`); changes += 1;
      } else {
        const result = mutateMatchingParagraphs(xml, { ...op, action });
        xml = result.xml; changes += result.changed;
      }
    }
    await writeFile(documentPath,xml,'utf8');
    await createZip(dir,tempOut);
    await copyFile(tempOut,output);
    return jsonResult({ path:output, operations:operations.length, changes, bytes:(await stat(output)).size });
  } finally {
    await rm(tempOut,{force:true}).catch(() => {});
    await removeTemp(dir);
  }
}

function pdfAnnotations(buffer) {
  const raw = buffer.toString('latin1');
  const rows = [];
  for (const match of raw.matchAll(/(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g)) {
    const body = match[3];
    if (!/\/Type\s*\/Annot\b|\/Subtype\s*\/(?:Text|FreeText|Highlight|Underline|StrikeOut|Square|Circle|Stamp|Ink|Link)\b/.test(body)) continue;
    rows.push({
      object:Number(match[1]),
      generation:Number(match[2]),
      subtype:body.match(/\/Subtype\s*\/([A-Za-z]+)/)?.[1] || null,
      contents:body.match(/\/Contents\s*\(((?:\\.|[^\\()])*)\)/)?.[1] || null,
      rect:body.match(/\/Rect\s*\[([^\]]+)\]/)?.[1]?.trim().split(/\s+/).map(Number) || null,
    });
  }
  return rows;
}

export async function pdfAction(args) {
  const action = requireEnum(args.action,'action',['merge','split','extract_pages','annotations','info']);
  if (action === 'annotations') {
    const source = await resolveSafePath(args.path,'path');
    return jsonResult({ path:source, annotations:pdfAnnotations(await readFile(source)) });
  }
  if (action === 'info') {
    const source = await resolveSafePath(args.path,'path');
    if (commandExists('pdfinfo')) return text((await runFile('pdfinfo',[source],{label:'pdfinfo'})).stdout);
    const data = await readFile(source); return jsonResult({ path:source, bytes:data.length, annotations:pdfAnnotations(data).length });
  }
  if (action === 'merge') {
    const requested = Array.isArray(args.paths) ? args.paths : [];
    if (requested.length < 2 || requested.length > 100) throw new Error('merge requires 2..100 PDFs in paths');
    const sources=[]; for(const value of requested) sources.push(await resolveSafePath(value,'paths'));
    const output=await resolveSafePath(args.output,'output');
    if(commandExists('pdfunite')) await runFile('pdfunite',[...sources,output],{label:'PDF merge',timeout:60_000});
    else if(commandExists('qpdf')) await runFile('qpdf',['--empty','--pages',...sources,'--',output],{label:'PDF merge',timeout:60_000});
    else unavailable('PDF merge','install poppler-utils (pdfunite) or qpdf');
    return jsonResult({action,output,inputs:sources.length,bytes:(await stat(output)).size});
  }
  const source=await resolveSafePath(args.path,'path');
  if(action==='split'){
    const outputDir=await resolveSafePath(args.output_dir || path.dirname(source),'output_dir'); await mkdir(outputDir,{recursive:true});
    const pattern=path.join(outputDir,optionalString(args.pattern)||`${path.basename(source,path.extname(source))}-%d.pdf`);
    if(commandExists('pdfseparate')) await runFile('pdfseparate',[source,pattern],{label:'PDF split',timeout:60_000});
    else unavailable('PDF split','install poppler-utils (pdfseparate)');
    return jsonResult({action,output_dir:outputDir,files:(await readdir(outputDir)).filter(name=>name.toLowerCase().endsWith('.pdf')).sort()});
  }
  const pages=optionalString(args.pages); if(!pages || !/^[0-9,\-\s]+$/.test(pages)) throw new Error('pages must look like 1-3,5');
  const output=await resolveSafePath(args.output,'output');
  if(commandExists('qpdf')) await runFile('qpdf',[source,'--pages','.',pages.replace(/\s+/g,''),'--',output],{label:'PDF extract pages',timeout:60_000});
  else if(commandExists('pdftk')) await runFile('pdftk',[source,'cat',...pages.replace(/\s+/g,'').split(','),'output',output],{label:'PDF extract pages',timeout:60_000});
  else unavailable('PDF page extraction','install qpdf or pdftk');
  return jsonResult({action,source,pages,output,bytes:(await stat(output)).size});
}

export const documentHandlers = {
  read_document:readDocument,
  edit_spreadsheet:editSpreadsheet,
  edit_document:editDocument,
  pdf_action:pdfAction,
};
