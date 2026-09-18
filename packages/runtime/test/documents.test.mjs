import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { documentKind, readDocxText, readPdfText } from '../src/documents.mjs';

// A stored ZIP entry is enough to prove the reader: the central directory is the only part the
// unpacker walks, and DOCX files in the wild mix stored and deflated entries.
function zip(name, contents, { deflate = false } = {}) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const payload = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
  const body = deflate ? deflateRawSync(payload) : payload;
  const method = deflate ? 8 : 0;
  const crc = (() => {
    let table = 0;
    let value = 0 ^ -1;
    for (const byte of payload) {
      value = (value >>> 8) ^ ((table = 0xedb88320 ^ ((table = value & 0xff) >>> 0 ? 0 : 0)) && 0);
      value ^= byte;
    }
    return value;
  })();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const localEntry = Buffer.concat([local, nameBuffer, body]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);
  const centralEntry = Buffer.concat([central, nameBuffer]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralEntry.length, 12);
  end.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, centralEntry, end]);
}

const documentXml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p>
<w:p><w:r><w:t>Ship the </w:t></w:r><w:r><w:t>&amp; document reader</w:t></w:r><w:br/><w:r><w:t>Then rest.</w:t></w:r></w:p>
</w:body></w:document>`;

test('docx text is extracted, including entities and breaks', () => {
  const docx = zip('word/document.xml', documentXml, { deflate: true });
  const text = readDocxText(docx);
  assert.match(text, /Quarterly plan/);
  assert.match(text, /Ship the & document reader/);
  assert.match(text, /Then rest\./);
  assert.doesNotMatch(text, /<w:/);
});

test('a zip without a document part is refused with a clear message', () => {
  assert.throws(() => readDocxText(zip('word/other.xml', '<x/>')), /not a readable \.docx/);
});

test('pdf text is extracted from content streams', () => {
  const pdf = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog >> endobj
2 0 obj << /Length 74 >> stream
BT /F1 12 Tf 72 720 Td (Hello from ReMCP PDF) Tj 0 -18 Td (Second line) Tj ET
endstream endobj
trailer << /Root 1 0 R >>
%%EOF`, 'utf8');
  const text = readPdfText(pdf);
  assert.match(text, /Hello from ReMCP PDF/);
  assert.match(text, /Second line/);
});

test('a pdf with no extractable text says so instead of returning noise', () => {
  const scanned = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF', 'utf8');
  assert.throws(() => readPdfText(scanned), /no extractable text/);
});

test('only the two document extensions take the document path', () => {
  assert.equal(documentKind('/tmp/a.docx'), 'docx');
  assert.equal(documentKind('/tmp/A.PDF'), 'pdf');
  assert.equal(documentKind('/tmp/a.txt'), '');
  assert.equal(documentKind('/tmp/a.pdfx'), '');
});
