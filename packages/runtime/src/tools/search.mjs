import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { runtimeConfig } from '../config.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import {
  appendSearchResults,
  createSearchSession,
  finishSearchSession,
  getSearchSession,
  listSearchSessions,
  waitForSearchResults,
} from '../sessions.mjs';
import { clampInteger, displayPath, fail, globToRegExp, looksBinary, requireString, resolveSafePath, splitLines, text } from '../util.mjs';

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv']);
const SKIP_GLOBS = ['!**/node_modules/**', '!**/.git/**', '!**/.hg/**', '!**/.svn/**', '!**/dist/**', '!**/build/**', '!**/.cache/**', '!**/__pycache__/**', '!**/.venv/**', '!**/venv/**'];
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATTERN_LENGTH = 400;

let ripgrepPath;

function ripgrep() {
  if (ripgrepPath !== undefined) return ripgrepPath;
  try {
    const result = spawnSync('rg', ['--version'], { encoding: 'utf8' });
    ripgrepPath = !result.error && result.status === 0 ? 'rg' : null;
  } catch { ripgrepPath = null; }
  return ripgrepPath;
}

function normalizePattern(value, literal) {
  const pattern = requireString(value, 'pattern');
  if (pattern.length > MAX_PATTERN_LENGTH) fail(`pattern must be at most ${MAX_PATTERN_LENGTH} characters`);
  if (literal) return { regex: null, literal: pattern, patternIsLiteral: true };
  try { return { regex: new RegExp(pattern, 'g'), literal: null, patternIsLiteral: false }; } catch (error) {
    // Silently downgrading an invalid regular expression to a substring search changes the
    // meaning of the call without telling anyone.
    fail(`pattern is not a valid regular expression (${error instanceof Error ? error.message : String(error)}). Pass literalSearch: true to search for this text literally.`);
  }
}

// "*.js|*.ts" is the documented alternation form; ripgrep needs one -g per glob.
function splitGlobs(value) {
  return String(value || '').split('|').map(part => part.trim()).filter(Boolean);
}

// A file search pattern without any glob metacharacter means "files whose name contains
// this text", which is how callers read `pattern: "auth"`.
function fileNameGlob(pattern) {
  return /[*?[\]{}]/.test(pattern) ? pattern : `*${pattern}*`;
}

function matchLine(line, matcher, ignoreCase) {
  if (matcher.literal) {
    return ignoreCase ? line.toLowerCase().includes(matcher.literal.toLowerCase()) : line.includes(matcher.literal);
  }
  matcher.regex.lastIndex = 0;
  return matcher.regex.test(line);
}

function formatContentResult(file, lineNumber, line, contextLines) {
  const rows = [`${displayPath(file)}:${lineNumber}: ${line}`];
  for (const entry of contextLines) rows.push(`${displayPath(file)}-${entry.number}- ${entry.text}`);
  return rows.join('\n');
}

async function walk(target, options, onFile) {
  const info = await stat(target).catch(() => fail(`Search path not found: ${displayPath(target)}`));
  if (info.isFile()) { await onFile(target); return; }
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (options.stopped()) return;
    if (!options.includeHidden && entry.name.startsWith('.')) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (options.skipDirectories.has(entry.name)) continue;
      await walk(child, options, onFile);
    } else if (entry.isFile()) {
      await onFile(child);
    }
  }
}

function runRipgrep(session, { path: target, pattern, searchType, filePattern, ignoreCase, includeHidden, includeIgnored, contextLines, maxResults, patternIsLiteral }) {
  // Flags must come before the `--` separator: anything after it is treated as a path,
  // which silently turned `--hidden` into a search target.
  const args = ['--no-heading', '--color', 'never'];
  if (ignoreCase) args.push('--ignore-case');
  if (includeHidden) args.push('--hidden');
  if (!includeIgnored) for (const glob of SKIP_GLOBS) args.push('-g', glob);
  for (const glob of splitGlobs(filePattern)) args.push('-g', glob);
  if (searchType === 'files') {
    args.push('--files');
    args.push('-g', fileNameGlob(pattern));
    args.push('--', target);
  } else {
    args.push('--line-number', '--with-filename');
    if (patternIsLiteral) args.push('--fixed-strings');
    if (contextLines) args.push('-C', String(contextLines));
    args.push('--', pattern, target);
  }
  const child = spawn(ripgrep(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  session.cancel = () => child.kill('SIGTERM');
  let buffer = '';
  let stderr = '';
  let collected = 0;
  let capped = false;
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    const batch = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      batch.push(line);
      collected += 1;
      if (collected >= maxResults) { capped = true; child.kill('SIGTERM'); break; }
    }
    appendSearchResults(session, batch);
  });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000); });
  child.on('error', error => finishSearchSession(session, 'failed', error.message));
  child.on('close', code => {
    if (session.status !== 'running') { finishSearchSession(session, session.status); return; }
    // ripgrep exits 2 for a real error (bad pattern, unreadable path) and 0/1 otherwise.
    if (code === 2 && stderr.trim()) { finishSearchSession(session, 'failed', stderr.trim().split('\n')[0]); return; }
    finishSearchSession(session, capped ? 'capped' : 'completed');
  });
}

async function runFallback(session, { path: target, matcher, searchType, filePattern, ignoreCase, contextLines, maxResults, includeHidden, includeIgnored }) {
  const fileGlobs = splitGlobs(filePattern).map(globToRegExp);
  const nameGlob = searchType === 'files' ? globToRegExp(fileNameGlob(session.pattern)) : null;
  const nameLiteral = searchType === 'files' && !/[*?[\]{}]/.test(session.pattern) ? session.pattern : null;
  let collected = 0;
  await walk(target, { includeHidden, skipDirectories: includeIgnored ? new Set() : SKIP_DIRECTORIES, stopped: () => session.status !== 'running' || collected >= maxResults }, async file => {
    if (session.status !== 'running' || collected >= maxResults) return;
    if (fileGlobs.length && !fileGlobs.some(glob => glob.test(path.basename(file)))) return;
    if (searchType === 'files') {
      const base = path.basename(file);
      const matches = (nameGlob && nameGlob.test(base)) || (nameLiteral && (ignoreCase ? base.toLowerCase().includes(nameLiteral.toLowerCase()) : base.includes(nameLiteral)));
      if (!matches) return;
      collected += 1;
      appendSearchResults(session, [displayPath(file)]);
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info || info.size > MAX_FALLBACK_FILE_BYTES) return;
    const buffer = await readFile(file).catch(() => null);
    if (!buffer || looksBinary(buffer)) return;
    const lines = splitLines(buffer.toString('utf8'));
    for (let index = 0; index < lines.length; index += 1) {
      if (session.status !== 'running' || collected >= maxResults) return;
      if (!matchLine(lines[index], matcher, ignoreCase)) continue;
      const context = [];
      if (contextLines) {
        for (let offset = Math.max(0, index - contextLines); offset <= Math.min(lines.length - 1, index + contextLines); offset += 1) {
          if (offset === index) continue;
          context.push({ number: offset + 1, text: lines[offset] });
        }
      }
      collected += 1;
      appendSearchResults(session, [formatContentResult(file, index + 1, lines[index], context)]);
    }
  });
  finishSearchSession(session, session.status === 'running' ? (collected >= maxResults ? 'capped' : 'completed') : session.status);
}

export async function startSearchTool(args) {
  const target = await resolveSafePath(args.path);
  await stat(target).catch(() => fail(`Search path not found: ${displayPath(target)}`));
  const pattern = requireString(args.pattern, 'pattern');
  const searchType = String(args.searchType || 'content').toLowerCase();
  if (!['content', 'files'].includes(searchType)) fail('searchType must be content or files');
  const filePattern = typeof args.filePattern === 'string' && args.filePattern.trim() ? args.filePattern.trim() : null;
  if (filePattern && path.isAbsolute(filePattern)) fail('filePattern must be a relative glob such as "*.ts"');
  const ignoreCase = args.ignoreCase === true;
  const includeHidden = args.includeHidden === true;
  const includeIgnored = args.includeIgnored === true;
  const contextLines = clampInteger(args.contextLines, 0, 0, 10);
  const maxResults = clampInteger(args.maxResults, 200, 1, 5000);
  const matcher = searchType === 'content' ? normalizePattern(pattern, args.literalSearch === true) : { regex: null, literal: pattern, patternIsLiteral: false };
  const session = createSearchSession({ type: searchType, pattern, path: target, filePattern });
  countEvent('searchesStarted');
  recordEvent('session_started', { sessionKind: 'search', success: true });
  const options = { path: target, pattern, searchType, filePattern, ignoreCase, includeHidden, includeIgnored, contextLines, maxResults, matcher, patternIsLiteral: matcher.patternIsLiteral === true };
  // Literal searches also go to ripgrep through --fixed-strings; the JavaScript fallback
  // only runs when ripgrep is unavailable.
  if (ripgrep()) runRipgrep(session, options);
  else void runFallback(session, options).catch(error => finishSearchSession(session, 'failed', error instanceof Error ? error.message : String(error)));
  await waitForSearchResults(session, 1, 1500);
  const initial = session.results.slice(0, 50);
  const status = session.error ? `failed: ${session.error}` : session.status;
  return text([
    `searchId: ${session.id} · type: ${searchType} · status: ${status} · results so far: ${session.results.length}`,
    `pattern: ${pattern} · path: ${displayPath(target)}`,
    initial.join('\n'),
    session.results.length > initial.length ? `… ${session.results.length - initial.length} more results buffered; use get_more_search_results with searchId ${session.id}` : '',
  ].filter(Boolean).join('\n'));
}

export async function getMoreSearchResultsTool(args) {
  const sessionId = requireString(args.sessionId, 'sessionId');
  const session = getSearchSession(sessionId) || fail(`No search session ${sessionId}`);
  const length = clampInteger(args.length, 100, 1, 1000);
  const offset = Number.isFinite(Number(args.offset)) ? Math.trunc(Number(args.offset)) : 0;
  if (offset >= 0) await waitForSearchResults(session, offset + length, 1000);
  const total = session.results.length;
  let start;
  let end;
  if (offset < 0) {
    start = Math.max(0, total + offset);
    end = total;
  } else {
    start = Math.min(offset, total);
    end = Math.min(start + length, total);
  }
  const status = session.error ? `failed: ${session.error}` : session.status;
  return text([
    `searchId: ${session.id} · status: ${status} · results ${start}-${end} of ${total}`,
    session.results.slice(start, end).join('\n'),
  ].filter(Boolean).join('\n'));
}

export async function stopSearchTool(args) {
  const sessionId = requireString(args.sessionId, 'sessionId');
  const session = getSearchSession(sessionId) || fail(`No search session ${sessionId}`);
  if (session.status !== 'running') return text(`Search ${sessionId} already ${session.status} with ${session.results.length} results.`);
  session.status = 'stopped';
  try { session.cancel?.(); } catch {}
  finishSearchSession(session, 'stopped');
  return text(`Stopped search ${sessionId} with ${session.results.length} results buffered.`);
}

export async function listSearchesTool() {
  const sessions = listSearchSessions();
  if (!sessions.length) return text('No active searches.');
  const rows = sessions.map(session => {
    const runtimeMs = (session.finishedAt || Date.now()) - session.startedAt;
    return `${session.id} · ${session.type} · ${session.status} · ${session.results.length} results · ${Math.round(runtimeMs / 1000)}s · ${session.pattern} (${displayPath(session.path)})`;
  });
  return text(rows.join('\n'));
}

export const searchToolHandlers = {
  start_search: startSearchTool,
  get_more_search_results: getMoreSearchResultsTool,
  stop_search: stopSearchTool,
  list_searches: listSearchesTool,
};
