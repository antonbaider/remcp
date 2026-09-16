import { runtimeConfig } from './config.mjs';
import { fail } from './util.mjs';

// Catastrophic host-level commands that a remote model should never run by accident.
// This is a guardrail, not a sandbox: it protects against obvious mistakes and
// prompt-injected one-liners, not against a determined adversary who already has shell
// access through the paired account.
//
// Rules are matched against the *command word* of each shell segment, so a read-only
// command that merely mentions a dangerous word (`grep -n format README.md`,
// `cat notes/shutdown.md`) is not refused.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'nohup', 'command', 'builtin', 'time', 'nice', 'ionice', 'stdbuf', 'timeout', 'setsid', 'exec']);

const DANGEROUS_RULES = [
  { id: 'filesystem-format', description: 'formats a filesystem', commands: /^mkfs(\.[a-z0-9]+)?$/i, args: () => true },
  { id: 'raw-disk-write', description: 'writes raw data to a block device', commands: /^dd$/i, args: segment => /\bof=\s*\/dev\//i.test(segment) || /\bof=\s*\\\\\.\\/i.test(segment) },
  { id: 'disk-partition', description: 'repartitions a disk', commands: /^(fdisk|sfdisk|cfdisk|parted|diskpart|gdisk)$/i, args: () => true },
  { id: 'redirect-to-device', description: 'redirects output into a block device', commands: null, anySegment: />>?\s*\/dev\/(sd|hd|vd|nvme|mmcblk|disk)/i },
  { id: 'host-power', description: 'powers off or reboots the machine', commands: /^(shutdown|reboot|halt|poweroff|restart-computer|stop-computer)$/i, args: () => true },
  { id: 'init-runlevel', description: 'changes the init runlevel', commands: /^init$/i, args: segment => /\binit\s+[06]\b/i.test(segment) },
  { id: 'fork-bomb', description: 'starts a fork bomb', commands: null, anySegment: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/ },
  {
    id: 'recursive-root-delete',
    description: 'recursively deletes a root or home path',
    commands: /^rm$/i,
    args: segment => /(^|\s)-[a-z]*r[a-z]*(\s|$)/i.test(segment)
      && /(^|\s)-[a-z]*f[a-z]*(\s|$)/i.test(segment)
      && /(\s)(\/|\/\*|~|~\/\*|\$HOME|\$\{HOME\})(\s|$)/i.test(segment),
  },
  { id: 'chmod-root', description: 'recursively rewrites permissions on a root path', commands: /^chmod$/i, args: segment => /(\s)(\/|\/\*)(\s|$)/.test(segment) },
  { id: 'chown-root', description: 'recursively rewrites ownership on a root path', commands: /^chown$/i, args: segment => /(\s)(\/|\/\*)(\s|$)/.test(segment) },
  { id: 'history-rewrite', description: 'clears shell history to hide activity', commands: /^(history|shred)$/i, args: segment => /history\s+-c/.test(segment) || /\.(bash_)?history/.test(segment) },
  { id: 'windows-destructive', description: 'destroys Windows system state', commands: /^(format|bcdedit|diskpart)$/i, args: () => true },
  { id: 'windows-cipher-wipe', description: 'wipes free space on a Windows volume', commands: /^cipher$/i, args: segment => /\/w\b/i.test(segment) },
];

function normalize(command) {
  return String(command).replace(/\s+/g, ' ').trim();
}

// Split on shell control operators so each simple command is judged on its own command
// word instead of on every word in the line.
function segments(command) {
  return normalize(command)
    .split(/&&|\|\||[;|\n]/)
    .map(part => part.trim())
    .filter(Boolean);
}

function commandWord(segment) {
  const tokens = segment.split(' ').filter(Boolean);
  while (tokens.length) {
    const token = tokens[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { tokens.shift(); continue; }
    if (WRAPPERS.has(token.toLowerCase())) {
      tokens.shift();
      while (tokens.length && tokens[0].startsWith('-')) tokens.shift();
      if (token.toLowerCase() === 'timeout' && tokens.length && /^\d+[smhd]?$/.test(tokens[0])) tokens.shift();
      continue;
    }
    break;
  }
  const word = tokens[0] || '';
  return word.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '');
}

export function checkCommand(command) {
  const normalized = normalize(command);
  const parts = segments(normalized);
  const findings = [];
  for (const blocked of runtimeConfig.blockedCommands) {
    if (normalized.toLowerCase().includes(blocked.toLowerCase())) findings.push({ id: 'policy', description: blocked, source: 'device-policy' });
  }
  if (runtimeConfig.dangerousCommands !== 'allow') {
    for (const part of parts) {
      const word = commandWord(part);
      for (const rule of DANGEROUS_RULES) {
        const matches = rule.anySegment ? rule.anySegment.test(part) : Boolean(word && rule.commands?.test(word) && rule.args(part));
        if (matches) findings.push({ id: rule.id, description: rule.description, source: 'builtin' });
      }
    }
  }
  if (!findings.length) return { warned: false, mode: runtimeConfig.dangerousCommands };
  const unique = [...new Map(findings.map(item => [item.id + item.description, item])).values()];
  if (runtimeConfig.dangerousCommands === 'warn' && unique.every(item => item.source === 'builtin')) {
    return { warned: true, mode: 'warn', findings: unique };
  }
  return { blocked: true, mode: runtimeConfig.dangerousCommands, findings: unique };
}

export function assertAllowedCommand(command) {
  const verdict = checkCommand(command);
  if (verdict.blocked) {
    const detail = verdict.findings.map(item => item.description).join(', ');
    fail(`Command blocked by ReMCP device policy (${detail}). Set REMCP_RUNTIME_BLOCKED_COMMANDS to adjust the device list, or REMCP_RUNTIME_DANGEROUS_COMMANDS=allow to disable the built-in catastrophic-command guardrail.`);
  }
  return verdict;
}

export const dangerousPatternIds = DANGEROUS_RULES.map(entry => entry.id);
