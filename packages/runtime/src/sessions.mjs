import process from 'node:process';
import { liveConfig, runtimeConfig } from './config.mjs';

const processSessions = new Map();
const searchSessions = new Map();
let searchCounter = 0;

const EXITED_SESSION_TTL_MS = 30 * 60 * 1000;
// A stream with no newlines (a minified bundle, `yes`, a binary accidentally catted)
// used to grow `partial` without bound: 40 MB measured, then a RangeError inside the
// data handler killed the runtime. Split long partials and cap the retained characters.
const MAX_PARTIAL_BYTES = 64 * 1024;
const MAX_BUFFERED_CHARS = 8 * 1024 * 1024;

function trimBuffer(session) {
  const overflow = session.lines.length - liveConfig('maxBufferedLines');
  if (overflow > 0) {
    const removed = session.lines.splice(0, overflow);
    for (const line of removed) session.bufferedChars -= line.length;
    session.droppedLines += overflow;
  }
  while (session.bufferedChars > MAX_BUFFERED_CHARS && session.lines.length > 0) {
    session.bufferedChars -= session.lines.shift().length;
    session.droppedLines += 1;
  }
}

function pushLine(session, line) {
  session.lines.push(line);
  session.bufferedChars += line.length;
}

function notify(session) {
  const waiters = session.waiters.splice(0, session.waiters.length);
  for (const resolve of waiters) resolve();
}

// A waiter whose timer fires first must remove itself, otherwise finished sessions keep
// holding closures until the next append (which may never come).
function waiter(session, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = session.waiters.indexOf(finish);
      if (index !== -1) session.waiters.splice(index, 1);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, timeoutMs));
    timer.unref?.();
    session.waiters.push(finish);
  });
}

export function createProcessSession({ pid, child, command, shell }) {
  const session = {
    pid,
    child,
    command,
    shell,
    startedAt: Date.now(),
    finishedAt: null,
    lines: [],
    partial: '',
    lastPartialRead: null,
    droppedLines: 0,
    bufferedChars: 0,
    cursor: 0,
    // wait_for_process_output has its own consumption watermark. start_process may
    // display initial output and advance the ordinary read cursor, but the first
    // wait must still be able to match that retained output once.
    waitCursor: 0,
    exitCode: null,
    signal: null,
    exited: false,
    waiters: [],
    lastActivityAt: Date.now(),
  };
  processSessions.set(pid, session);
  return session;
}

function drainPartial(session) {  while (session.partial.length > MAX_PARTIAL_BYTES) {
    pushLine(session, session.partial.slice(0, MAX_PARTIAL_BYTES));
    session.partial = session.partial.slice(MAX_PARTIAL_BYTES);
    session.partialSplit = true;
  }
}

export function appendProcessOutput(session, chunk) {
  const combined = session.partial + chunk;
  const parts = combined.split('\n');
  session.partial = parts.pop() ?? '';
  for (const line of parts) pushLine(session, line);
  drainPartial(session);
  trimBuffer(session);
  session.lastActivityAt = Date.now();
  notify(session);
}

export function markProcessExited(session, code, signal) {
  if (session.exited) return;
  if (session.partial) {
    pushLine(session, session.partial);
    session.partial = '';
  }
  session.exited = true;
  session.exitCode = code;
  session.signal = signal;
  session.finishedAt = Date.now();
  trimBuffer(session);
  notify(session);
}

export function getProcessSession(pid) {
  return processSessions.get(pid) || null;
}

export function listProcessSessions() {
  sweep();
  return [...processSessions.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function absoluteLine(session, index) {
  return session.droppedLines + index + 1;
}

export function totalLines(session) {
  return session.droppedLines + session.lines.length + (session.partial ? 1 : 0);
}

export function readNewOutput(session) {
  const from = Math.max(0, session.cursor - session.droppedLines);
  const complete = session.lines.slice(from);
  session.cursor = session.droppedLines + session.lines.length;
  const parts = [...complete];
  if (session.partial && session.partial !== session.lastPartialRead) parts.push(session.partial);
  session.lastPartialRead = session.partial || null;
  return parts;
}

export function hasNewOutput(session) {
  if (session.cursor < session.droppedLines + session.lines.length) return true;
  return Boolean(session.partial && session.partial !== session.lastPartialRead);
}

// A ranged read is a peek: it must not consume the new-output cursor, or reading a tail
// makes the lines before it undeliverable.
export function readOutputRange(session, offset, length) {
  const snapshot = session.lines.concat(session.partial ? [session.partial] : []);
  const total = session.droppedLines + snapshot.length;
  const requested = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0;
  let start;
  let end;
  if (requested < 0) {
    start = Math.max(0, snapshot.length + requested);
    end = snapshot.length;
  } else {
    start = Math.max(0, Math.min(requested - session.droppedLines, snapshot.length));
    end = Math.min(snapshot.length, start + Math.max(1, Math.trunc(length || 200)));
  }
  return { slice: snapshot.slice(start, end), start: session.droppedLines + start + 1, end: session.droppedLines + end, total };
}

export async function waitForProcessActivity(session, timeoutMs) {
  if (session.exited) return;
  await waiter(session, timeoutMs);
}

export async function waitForProcessExit(session, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!session.exited && Date.now() < deadline) {
    await waitForProcessActivity(session, Math.min(100, Math.max(10, deadline - Date.now())));
  }
}

export function createSearchSession({ type, pattern, path, filePattern }) {
  const session = {
    id: `search-${++searchCounter}`,
    type,
    pattern,
    path,
    filePattern: filePattern || null,
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    status: 'running',
    error: null,
    cancel: null,
    waiters: [],
    lastActivityAt: Date.now(),
  };
  searchSessions.set(session.id, session);
  return session;
}

export function appendSearchResults(session, results) {
  if (!results.length) return;
  session.results.push(...results);
  session.lastActivityAt = Date.now();
  notify(session);
}

export function finishSearchSession(session, status, error = null) {
  session.status = status;
  session.error = error ? String(error) : null;
  session.finishedAt = Date.now();
  session.cancel = null;
  notify(session);
}

export function getSearchSession(id) {
  return searchSessions.get(String(id)) || null;
}

export function listSearchSessions() {
  sweep();
  return [...searchSessions.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export async function waitForSearchResults(session, count, timeoutMs) {
  if (session.results.length >= count || session.status !== 'running') return;
  await waiter(session, timeoutMs);
}

export function sweep(now = Date.now()) {
  for (const [pid, session] of processSessions) {
    if (session.exited && session.finishedAt && now - session.finishedAt > EXITED_SESSION_TTL_MS) processSessions.delete(pid);
  }
  for (const [id, session] of searchSessions) {
    if (session.status !== 'running' && session.finishedAt && now - session.finishedAt > EXITED_SESSION_TTL_MS) searchSessions.delete(id);
  }
}

// Eviction used to run only inside list_sessions/list_searches, so an agent that never
// listed them kept abandoned sessions (and their result arrays) in memory forever.
let sweepTimer = null;
export function startSessionSweeper(intervalMs = 5 * 60 * 1000) {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweep(), intervalMs);
  sweepTimer.unref?.();
}

// The child is spawned detached on POSIX so it owns a process group; killing the group
// takes the whole tree with it (`sleep 20 | cat` used to survive `force_terminate`).
export function killSessionTree(session, signal = 'SIGKILL') {
  const child = session.child;
  if (!child || session.exited) return false;
  try {
    if (process.platform === 'win32') return child.kill(signal);
    if (child.pid) process.kill(-child.pid, signal);
    else return child.kill(signal);
    return true;
  } catch {
    try { return child.kill(signal); } catch { return false; }
  }
}

export function shutdownSessions() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  for (const session of processSessions.values()) {
    if (!session.exited) killSessionTree(session, 'SIGKILL');
  }
  for (const session of searchSessions.values()) {
    if (session.status === 'running' && session.cancel) {
      try { session.cancel(); } catch {}
    }
  }
}
