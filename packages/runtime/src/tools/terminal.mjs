import process from 'node:process';
import { spawn } from 'node:child_process';
import { runtimeConfig } from '../config.mjs';
import { assertAllowedCommand } from '../policy.mjs';
import { countEvent, recordEvent } from '../telemetry.mjs';
import {
  absoluteLine,
  appendProcessOutput,
  createProcessSession,
  getProcessSession,
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

export async function startProcessTool(args) {
  const command = requireString(args.command, 'command');
  const verdict = assertAllowedCommand(command);
  if (verdict.warned) {
    countEvent('policyBlocks');
    recordEvent('policy_block', { reason: verdict.findings?.[0]?.id || 'builtin', success: false });
  }
  const timeoutMs = clampInteger(args.timeout_ms, 1000, 0, 120000);
  const shell = shellCommand();
  const child = spawn(shell, shellArgs(command), {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (!child.pid) fail('Could not start the command');
  const session = createProcessSession({ pid: child.pid, child, command, shell });
  recordEvent('session_started', { sessionKind: 'process', success: true });
  child.stdout?.on('data', chunk => appendProcessOutput(session, chunk.toString('utf8')));
  child.stderr?.on('data', chunk => appendProcessOutput(session, chunk.toString('utf8')));
  child.on('error', error => { appendProcessOutput(session, `${error.message}\n`); markProcessExited(session, null, null); });
  child.on('close', (code, signal) => markProcessExited(session, code, signal));
  await waitForProcessExit(session, timeoutMs);
  const headline = session.exited
    ? `Process ${session.pid} finished${session.exitCode === null ? '' : ` with code ${session.exitCode}`}.`
    : `Process ${session.pid} is running.`;
  const output = session.lines.slice(-200).join('\n');
  const partial = session.partial;
  session.cursor = session.droppedLines + session.lines.length;
  session.lastPartialRead = session.partial || null;
  const warning = verdict.warned ? `Warning: this command matches the built-in dangerous-command guardrail (${verdict.findings.map(item => item.description).join(', ')}).\n` : '';
  return text(`${warning}${[headline, output, partial].filter(Boolean).join('\n')}`);
}

export async function readProcessOutputTool(args) {
  const pid = requireInteger(args.pid, 'pid');
  const session = getProcessSession(pid);
  if (!session) fail(`No ReMCP session with pid ${pid}`);
  const timeoutMs = clampInteger(args.timeout_ms, 0, 0, 120000);
  const hasOffset = args.offset !== undefined && args.offset !== null;
  let slice;
  let range;
  if (hasOffset && Number(args.offset) !== 0) {
    const requested = Number(args.offset) < 0 ? Number(args.offset) : absoluteLine(session, 0) - 1 + Number(args.offset);
    const page = readOutputRange(session, requested, clampInteger(args.length, 200, 1, 5000));
    slice = page.slice;
    range = `${page.start}-${page.end} of ${page.total}`;
  } else {
    if (timeoutMs) await waitForProcessActivity(session, timeoutMs);
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

export async function waitForProcessOutputTool(args) {
  const pid = requireInteger(args.pid, 'pid');
  const session = getProcessSession(pid);
  if (!session) fail(`No ReMCP session with pid ${pid}`);
  const pattern = requireString(args.pattern, 'pattern');
  const matcher = compileWaiter(pattern);
  const timeoutMs = clampInteger(args.timeout_ms, 10000, 0, 120000);
  const startLine = Math.max(0, session.cursor - session.droppedLines);
  const deadline = Date.now() + timeoutMs;
  let slice = session.lines.slice(startLine);
  while (!waiterMatches(slice, matcher) && Date.now() < deadline && !session.exited) {
    await waitForProcessActivity(session, Math.min(250, Math.max(20, deadline - Date.now())));
    slice = session.lines.slice(startLine);
  }
  const matched = waiterMatches(slice, matcher);
  session.cursor = session.droppedLines + session.lines.length;
  session.lastPartialRead = session.partial || null;
  const status = describeSession(session);
  const headline = matched
    ? `pid ${pid} ${status.status} · pattern matched`
    : `pid ${pid} ${status.status} · pattern not matched within ${timeoutMs}ms`;
  return text([headline, slice.join('\n')].filter(Boolean).join('\n'));
}

export async function interactWithProcessTool(args) {
  const pid = requireInteger(args.pid, 'pid');
  const session = getProcessSession(pid);
  if (!session) fail(`No ReMCP session with pid ${pid}`);
  if (session.exited) fail(`Process ${pid} already exited`);
  const input = typeof args.input === 'string' ? args.input : fail('input must be a string');
  const timeoutMs = clampInteger(args.timeout_ms, 1000, 0, 120000);
  session.cursor = session.droppedLines + session.lines.length;
  session.lastPartialRead = null;
  session.child.stdin?.write(`${input}\n`);
  await waitForProcessActivity(session, timeoutMs);
  const slice = readNewOutput(session);
  const status = describeSession(session);
  return text([`pid ${pid} ${status.status}`, slice.join('\n')].filter(Boolean).join('\n'));
}

export async function forceTerminateTool(args) {
  const pid = requireInteger(args.pid, 'pid');
  const session = getProcessSession(pid);
  if (!session) fail(`No ReMCP session with pid ${pid}`);
  if (session.exited) return text(`Process ${pid} already exited.`);
  try { session.child.kill('SIGTERM'); } catch {}
  const deadline = Date.now() + 2000;
  while (!session.exited && Date.now() < deadline) await waitForProcessActivity(session, 100);
  if (!session.exited) {
    try { session.child.kill('SIGKILL'); } catch {}
    await waitForProcessActivity(session, 1000);
  }
  const status = describeSession(session);
  return text(`Terminated session ${pid}. Status: ${status.status}.`);
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
