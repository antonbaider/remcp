import { inflateRawSync, inflateSync } from 'node:zlib';

// Reading PDF and DOCX without pulling a document stack into the device runtime.
//
// Desktop Commander installs libraries for this. ReMCP keeps its one-dependency promise and reads the
// two formats that are actually documents with text in them:
//
//   DOCX - a ZIP whose word/document.xml holds the text in <w:t> elements. Inflating a stored or
//          deflated entry is all that is needed.
//   PDF  - objects with content streams. Text drawn with the standard encodings (Tj/TJ/'/") is
//          extracted; a PDF that uses embedded subset fonts with custom CMaps cannot be read this
//          way, and says so instead of returning mojibake.
//
// Nothing here writes, and nothing leaves the computer.

const MAX_INFLATE_BYTES = 32 * 1024 * 1024;

function inflate(buffer, raw = false) {
  try {
    const out = raw ? inflateRawSync(buffer, { maxOutputLength: MAX_INFLATE_BYTES }) : inflateSync(buffer, { maxOutputLength: MAX_INFLATE_BYTES });
    return out;
  } catch {
    return null;
  }
}

function unzipEntry(buffer, wanted) {
  // Walk the central directory once: enough to find one entry without implementing the whole format.
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count && offset + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return inflate(raw, true);
      return null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const DOCX_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

export function readDocxText(buffer) {
  const document = unzipEntry(buffer, 'word/document.xml');
  if (!document) throw new Error('This file is not a readable .docx (its word/document.xml is missing or compressed in an unsupported way)');
  const xml = document.toString('utf8');
  // Paragraph and line breaks become newlines, tabs become tabs, everything else is text.
  const withBreaks = xml
    .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t');
  const text = withBreaks.replace(/<[^>]+>/g, '');
  return text
    .replace(/&(amp|lt|gt|quot|apos);/g, match => DOCX_ENTITIES[match])
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodePdfString(raw) {
  // Literal strings arrive with backslash escapes; hex strings are pairs of hex digits.
  return raw
    .replace(/\\([nrtbf()\\])/g, (_match, character) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[character] ?? character))
    .replace(/\\([0-7]{1,3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function readPdfText(buffer) {
  const raw = buffer.toString('latin1');
  const chunks = [];
  let index = 0;
  while (index < raw.length) {
    const streamStart = raw.indexOf('stream', index);
    if (streamStart < 0) break;
    let start = streamStart + 'stream'.length;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const body = Buffer.from(raw.slice(start, end), 'latin1');
    const decoded = body.subarray(0, 5).toString('latin1') === '<?xml' ? body : (inflate(body) ?? inflate(body, true) ?? body);
    chunks.push(decoded.toString('latin1'));
    index = end + 'endstream'.length;
  }
  const content = chunks.join('\n');

  const pieces = [];
  const showText = /(?:\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>)\s*Tj|\[((?:[^\][]|\\.)*)\]\s*TJ|\((?:\\.|[^\\()])*\)\s*['"]|T\*|Td|TD|ET/g;
  for (const match of content.matchAll(showText)) {
    const token = match[0];
    if (/^T\*|Td|TD|ET$/.test(token)) { pieces.push('\n'); continue; }
    if (token.includes('TJ')) {
      const array = match[1] ?? '';
      for (const part of array.matchAll(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g)) {
        const value = part[0];
        if (value.startsWith('(')) pieces.push(decodePdfString(value.slice(1, -1)));
        else pieces.push(Buffer.from(value.slice(1, -1).replace(/\s+/g, ''), 'hex').toString('latin1').replace(/\0/g, ''));
      }
      continue;
    }
    if (token.startsWith('(')) pieces.push(decodePdfString(token.slice(1, token.lastIndexOf(')'))));
    else if (token.startsWith('<')) pieces.push(Buffer.from(token.slice(1, token.indexOf('>')).replace(/\s+/g, ''), 'hex').toString('latin1').replace(/\0/g, ''));
  }
  const text = pieces.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const printable = text.replace(/[^\p{L}\p{N}\p{P}\p{Zs}\n\t]/gu, '');
  if (text.length < 8 || printable.length / Math.max(1, text.length) < 0.7) {
    throw new Error('This PDF has no extractable text — it is a scan, or it uses embedded fonts the built-in reader cannot decode. Run a text extraction tool on that computer (for example pdftotext) and read the result instead.');
  }
  return text;
}

export function documentKind(filePath) {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  return '';
}
