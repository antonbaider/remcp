import process from 'node:process';
import { spawn } from 'node:child_process';
import { runtimeConfig } from '../config.mjs';
import { assertAllowedCommand } from '../policy.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import {
  appendProcessOutput,
  createProcessSession,
  getProcessSession,
  hasNewOutput,
  killSessionTree,
  listProcessSessions,
  markProcessExited,
  readNewOutput,
  readOutputRange,
  totalLines,
  waitForProcessExit,
  waitForProcessActivity,
} from '../sessions.mjs';
import { clampInteger, fail, requireInteger, requireString, text } from '../util.mjs';

function shellCommand() {
  if (runtimeConfig.defaultShell) return runtimeConfig.defaultShell;
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

function shellArgs(command) {
  if (process.platform === 'win32') return ['/d', '/s', '/c', command];
  return ['-c', command];
}

function describeSession(session) {
  const status = session.exited ? `exited${session.signal ? ` (${session.signal})` : session.exitCode === null ? '' : ` (code ${session.exitCode})`}` : 'running';
  return { pid: session.pid, status, runtimeMs: (session.finishedAt || Date.now()) - session.startedAt, lines: totalLines(session) };
}

function abortError() {
  return new Error('Tool call was cancelled by the client');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export async function startProcessTool(args, extra = {}) {
  const command = requireString(args.command, 'command');
  const verdict = assertAllowedCommand(command);
  if (verdict.warned) {
    countEvent('policyBlocks');
    recordEvent('policy_block', { reason: verdict.findings?.[0]?.id || 'builtin', success: false });
  }
  const timeoutMs = clampInteger(args.timeout_ms, 1000, 0, 120000);
  const shell = shellCommand();
  // `detached` gives the child its own process group so a session can be stopped as a
  // tree; a pipeline such as `sleep 20 | cat` otherwise survives force_terminate.
  const child = spawn(shell, shellArgs(command), {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  // The error listener has to exist before anything can throw: a bogus REMCP_RUNTIME_SHELL
  // used to surface as an unhandled ENOENT that took the whole runtime down.
  child.on('error', error => {
    const session = child.remcpSession;
    if (session) {
      appendProcessOutput(session, `${error.message}\n`);
      markProcessExited(session, null, null);
    }
  });
  if (!child.pid) fail(`Could not start the command with ${shell}`);
  const session = createProcessSession({ pid: child.pid, child, command, shell });
  child.remcpSession = session;
  recordEvent('session_started', { sessionKind: 'process', success: true });

  if (child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.on('close', () => { session.stdinClosed = true; });
  }
  child.stdout?.on('data', chunk => appendProcessOutput(session, chunk.toString('utf8')));
  child.stderr?.on('data', chunk => appendProcessOutput(session, chunk.toString('utf8')));
  // `exit` carries the real status; `close` only follows once every stdio stream is done,
  // which for a backgrounded child can be seconds later.
  child.on('exit', (code, signal) => markProcessExited(session, code, signal));
  child.on('close', (code, signal) => markProcessExited(session, code, signal));

  await waitForProcessExit(session, timeoutMs);
  const headline = session.exited
    ? `Process ${session.pid} finished${session.exitCode === null ? '' : ` with code ${session.exitCode}`}${session.signal ? ` (${session.signal})` : ''}.`
    : `Process ${session.pid} is running.`;
  const output = session.lines.slice(-200).join('\n');
  const partial = session.partial;
  session.cursor = session.droppedLines + session.lines.length;
  session.lastPartialRead = session.partial || null;
  const warning = verdict.warned ? `Warning: this command matches the built-in dangerous-command guardrail (${verdict.findings.map(item => item.description).join(', ')}).\n` : '';
  return text(`${warning}${[headline, output, partial].filter(Boolean).join('\n')}`);
}

export async function readProcessOutputTool(args, extra = {}) {
  const pid = requireInteger(args.pid, 'pid');
  const session = getProcessSession(pid);
  if (!session) fail(`No ReMCP session with pid ${pid}`);
  const timeoutMs = clampInteger(args.timeout_ms, 0, 0, 120000);
  const hasOffset = args.offset !== undefined && args.offset !== null;
  let slice;
  let range;
  if (hasOffset) {
    // An explicit offset is a peek at a line range: it does not consume the new-output
    // cursor, so a caller can look at the tail and still read everything afterwards.
    // Zero-based from the first line the session produced; negative reads the last N.
    const page = readOutputRange(session, Number(args.offset), clampInteger(args.length, 200, 1, 5000));
    slice = page.slice;
    range = `${page.start}-${page.end} of ${page.total}`;
  } else {
    // Never sleep over output that is already buffered.
    if (timeoutMs && !hasNewOutput(session)) {
      const deadline = Date.now() + timeoutMs;
      while (!hasNewOutput(session) && !session.exited && Date.now() < deadline) {
        throwIfAborted(extra.signal);
        await waitForProcessActivity(session, Math.min(200, Math.max(20, deadline - Date.now())));
      }
    }
    slice = readNewOutput(session);
    const first = Math.max(1, session.cursor - slice.length + 1);
    range = slice.length ? `${first}-${session.cursor} of ${totalLines(session)}` : `no new output (${totalLines(session)} lines total)`;
  }
  const status = describeSession(session);
  const header = `pid ${pid} ${status.status} · lines ${range}`;
  return text(`${header}\n${slice.join('\n')}`);
}

function compileWaiter(pattern) {
  try { return { regex: new RegExp(pattern) }; } catch { return { literal: pattern }; }
}

function waiterMatches(lines, matcher) {
  if (matcher.literal) return lines.some(line => line.includes(matcher.literal));
  matcher.regex.lastIndex = 0;
  return lines.some(line => matcher.regex.test(line));
}

export async function waitForProcessOutputTool(args, extra = {}) {
  const pid = requireInteger(args.pid, 'pid');
  const session = getProcessSession(pid);
  if (!session) fail(`No ReMCP session with pid ${pid}`);
  const pattern = requireString(args.pattern, 'pattern');
  const matcher = compileWaiter(pattern);
  const timeoutMs = clampInteger(args.timeout_ms, 10000, 0, 120000);
  const cursorStart = Math.max(0, session.cursor - session.droppedLines);
  // Output that was already buffered before the call still counts: a pattern printed
  // earlier should answer immediately instead of spinning for the whole timeout.
  let slice = session.lines.slice(cursorStart);
  const bufferedMatch = waiterMatches(slice, matcher);
  const deadline = Date.now() + timeoutMs;
  if (!bufferedMatch) {
    while (!waiterMatches(session.lines.slice(cursorStart), matcher) && Date.now() < deadline && !session.exited) {
      throwIfAborted(extra.signal);
      await waitForProcessActivity(session, Math.min(250, Math.max(20, deadline - Date.now())));
    }
    slice = session.lines.slice(cursorStart);
  }
  const matched = waiterMatches(slice, matcher);
  session.cursor = session.droppedLines + session.lines.length;
  session.lastPartialRead = session.partial || null;
  const status = describeSession(session);
  const headline = matched
    ? `pid ${pid} ${status.status} · pattern matched${bufferedMatch ? ' (already buffered)' : ''}`
    : `pid ${pid} ${status.status} · pattern not matched within ${timeoutMs}ms`;
  return text([headline, slice.join('\n')].filter(Boolean).join('\n'));
}

export async function interactWithProcessTool(args, extra = {}) {
  const pid = requireInteger(args.pid, 'pid');
  const session = getProcessSession(pid);
  if (!session) fail(`No ReMCP session with pid ${pid}`);
  if (session.exited) fail(`Process ${pid} already exited`);
  const input = typeof args.input === 'string' ? args.input : fail('input must be a string');
  const timeoutMs = clampInteger(args.timeout_ms, 1000, 0, 120000);
  session.cursor = session.droppedLines + session.lines.length;
  session.lastPartialRead = null;
  throwIfAborted(extra.signal);
  const stdin = session.child?.stdin;
  if (!stdin || stdin.destroyed || session.stdinClosed) {
    fail(`Process ${pid} no longer accepts input`);
  }
  try {
    stdin.write(`${input}\n`);
  } catch (error) {
    // A closed read end used to raise an async EPIPE that killed the runtime.
    session.stdinClosed = true;
    fail(`Could not write to process ${pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (!hasNewOutput(session) && !session.exited && Date.now() < deadline) {
    throwIfAborted(extra.signal);
    await waitForProcessActivity(session, Math.min(200, Math.max(20, deadline - Date.now())));
  }
  const slice = readNewOutput(session);
  const status = describeSession(session);
  return text([`pid ${pid} ${status.status}`, slice.join('\n')].filter(Boolean).join('\n'));
}

export async function forceTerminateTool(args) {
  const pid = requireInteger(args.pid, 'pid');
  const session = getProcessSession(pid);
  if (!session) fail(`No ReMCP session with pid ${pid}`);
  if (session.exited) return text(`Process ${pid} already exited.`);
  killSessionTree(session, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (!session.exited && Date.now() < deadline) await waitForProcessActivity(session, 100);
  if (!session.exited) {
    killSessionTree(session, 'SIGKILL');
    await waitForProcessActivity(session, 1000);
  }
  const status = describeSession(session);
  return text(`Terminated session ${pid}${status.status.startsWith('exited') ? '' : ' (still running)'}. Status: ${status.status}.`);
}

export async function listSessionsTool() {
  const sessions = listProcessSessions();
  if (!sessions.length) return text('No active terminal sessions.');
  const rows = sessions.map(session => {
    const status = describeSession(session);
    const blocked = session.exited ? '' : session.partial ? 'blocked-possibly' : 'idle-or-running';
    return `pid ${status.pid} · ${status.status} · ${Math.round(status.runtimeMs / 1000)}s · ${blocked} · ${session.command.slice(0, 120)}`;
  });
  return text(rows.join('\n'));
}

export const terminalToolHandlers = {
  start_process: startProcessTool,
  read_process_output: readProcessOutputTool,
  wait_for_process_output: waitForProcessOutputTool,
  interact_with_process: interactWithProcessTool,
  force_terminate: forceTerminateTool,
  list_sessions: listSessionsTool,
};
