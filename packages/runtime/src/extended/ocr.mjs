import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { clamp, commandExists, removeTemp, runFile, tempDir } from './common.mjs';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function normalizeText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function ocrCapabilityAvailable() {
  return commandExists('tesseract');
}

function safeLanguage(value) {
  const language = String(value || 'eng').trim();
  if (!/^[A-Za-z0-9_+.-]{1,64}$/.test(language)) throw new Error('ocr_language contains unsupported characters');
  return language;
}

export function parseTesseractTsv(tsv, maxWords = 2000) {
  const rows = String(tsv || '').split(/\r?\n/);
  if (!rows.length) return { words: [], lines: [] };
  const header = rows.shift().split('\t');
  const at = name => header.indexOf(name);
  const indexes = {
    level: at('level'), page: at('page_num'), block: at('block_num'), par: at('par_num'), line: at('line_num'),
    left: at('left'), top: at('top'), width: at('width'), height: at('height'), conf: at('conf'), text: at('text'),
  };
  const words = [];
  let totalWords = 0;
  for (const raw of rows) {
    if (!raw.trim()) continue;
    const columns = raw.split('\t');
    if (Number(columns[indexes.level]) !== 5) continue;
    const text = String(columns[indexes.text] || '').trim();
    if (!text) continue;
    totalWords += 1;
    if (words.length >= maxWords) continue;
    const confidence = Number(columns[indexes.conf]);
    const left = Number(columns[indexes.left]);
    const top = Number(columns[indexes.top]);
    const width = Number(columns[indexes.width]);
    const height = Number(columns[indexes.height]);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    words.push({
      text,
      confidence: Number.isFinite(confidence) ? confidence : null,
      x: left,
      y: top,
      width,
      height,
      page: Number(columns[indexes.page]) || 0,
      block: Number(columns[indexes.block]) || 0,
      paragraph: Number(columns[indexes.par]) || 0,
      line: Number(columns[indexes.line]) || 0,
    });
  }

  const grouped = new Map();
  for (const word of words) {
    const key = [word.page, word.block, word.paragraph, word.line].join(':');
    const group = grouped.get(key) || [];
    group.push(word);
    grouped.set(key, group);
  }
  const lines = [...grouped.values()].map(group => {
    const x1 = Math.min(...group.map(word => word.x));
    const y1 = Math.min(...group.map(word => word.y));
    const x2 = Math.max(...group.map(word => word.x + word.width));
    const y2 = Math.max(...group.map(word => word.y + word.height));
    const confidences = group.map(word => word.confidence).filter(Number.isFinite);
    return {
      text: group.map(word => word.text).join(' '),
      confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      words: group.length,
    };
  });
  return { words, lines, totalWords };
}

export async function ocrImage(imageBuffer, options = {}) {
  if (!ocrCapabilityAvailable()) return { available: false, reason: 'tesseract is not installed on this computer' };
  const data = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer || []);
  if (!data.length) return { available: false, reason: 'no screenshot image was available for OCR' };
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`OCR image is too large (${data.length} bytes; maximum ${MAX_IMAGE_BYTES})`);

  const language = safeLanguage(options.language);
  const psm = clamp(options.psm, 11, 3, 13);
  const maxWords = clamp(options.max_words, 2000, 1, 10_000);
  const dir = await tempDir('remcp-ocr-');
  const input = path.join(dir, 'screen.png');
  try {
    await writeFile(input, data, { mode: 0o600 });
    const result = await runFile('tesseract', [input, 'stdout', '-l', language, '--psm', String(psm), 'tsv'], {
      label: 'OCR',
      timeout: clamp(options.timeout_ms, 30_000, 1000, 120_000),
      maxBuffer: 16 * 1024 * 1024,
      allowFailure: true,
    });
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 1000);
      return { available: false, reason: `tesseract failed: ${detail}` };
    }
    const parsed = parseTesseractTsv(result.stdout, maxWords);
    return {
      available: true,
      backend: 'tesseract',
      language,
      text: parsed.lines.map(line => line.text).join('\n'),
      count: parsed.words.length,
      total_words: parsed.totalWords,
      truncated: parsed.totalWords > parsed.words.length,
      words: parsed.words,
      lines: parsed.lines,
    };
  } finally {
    await removeTemp(dir);
  }
}

export function findOcrText(ocr, needle) {
  if (!ocr?.available) return null;
  const wanted = normalizeText(needle);
  if (!wanted) return null;
  const lineMatches = (ocr.lines || []).filter(line => normalizeText(line.text).includes(wanted));
  if (lineMatches.length) {
    return [...lineMatches].sort((a, b) => (Number(b.confidence) || -1) - (Number(a.confidence) || -1))[0];
  }
  const wordMatches = (ocr.words || []).filter(word => normalizeText(word.text).includes(wanted));
  if (wordMatches.length) {
    return [...wordMatches].sort((a, b) => (Number(b.confidence) || -1) - (Number(a.confidence) || -1))[0];
  }
  return null;
}
