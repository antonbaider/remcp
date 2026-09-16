import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clampInteger, fail, requireInteger, text } from '../util.mjs';

const run = promisify(execFile);

const PROTECTED_PIDS = new Set([0, 1]);
const SECRET_FLAG = /((?:^|\s)(?:--)?[A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTHORIZATION)[A-Za-z0-9_-]*)([=:]\s*)(\S+)/gi;

export function redactSecrets(command) {
  return String(command).replace(SECRET_FLAG, '$1$2***');
}

export async function listProcessesTool(args = {}) {
  const limit = clampInteger(args.limit, 100, 1, 1000);
  const rows = [];
  const parsed = [];
  if (process.platform === 'win32') {
    const { stdout } = await run('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 8 * 1024 * 1024 }).catch(error => fail(`Could not list processes: ${error.message}`));
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.split('","').map(part => part.replace(/^"|"$/g, ''));
      if (parts.length >= 5) parsed.push({ mem: parts[4], row: `${redactSecrets(parts[0])},${parts[1]},${parts[2]},${parts[4]}` });
    }
  } else {
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,pcpu=,pmem=,etime=,comm=,args='], { maxBuffer: 8 * 1024 * 1024 }).catch(error => fail(`Could not list processes: ${error.message}`));
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!match) continue;
      const [, pid, ppid, cpu, mem, elapsed, comm, args] = match;
      parsed.push({ cpu: Number(cpu), mem: Number(mem), row: `${pid},${ppid},${cpu},${mem},${elapsed},${redactSecrets((args || comm).slice(0, 200))}` });
    }
    parsed.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  }
  rows.push('pid,ppid,cpu%,mem%,elapsed,command');
  rows.push(...parsed.slice(0, limit).map(entry => entry.row));
  if (parsed.length > limit) rows.push(`… ${parsed.length - limit} more processes hidden; call list_processes with a higher limit to see them`);
  return text(rows.join('\n'));
}

export async function killProcessTool(args) {
  const pid = requireInteger(args.pid, 'pid');
  if (PROTECTED_PIDS.has(pid)) fail(`Refusing to terminate protected pid ${pid}`);
  if (pid === process.pid) fail('Refusing to terminate the ReMCP runtime process');
  if (pid === process.ppid) fail('Refusing to terminate the ReMCP agent process that hosts this runtime');
  try {
    if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    else process.kill(pid, 'SIGTERM');
  } catch (error) {
    fail(`Could not terminate pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (process.platform !== 'win32') {
    await new Promise(resolve => setTimeout(resolve, 1500));
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {}
  }
  return text(`Termination signal sent to pid ${pid}.`);
}

export const systemToolHandlers = {
  list_processes: listProcessesTool,
  kill_process: killProcessTool,
};
