import { runtimeConfig } from './config.mjs';
import { fail } from './util.mjs';

// Catastrophic host-level commands that a remote model should never run by accident.
// This is a guardrail, not a sandbox: it protects against obvious mistakes and
// prompt-injected one-liners, not against a determined adversary who already has
// shell access through the paired account.
const DANGEROUS_PATTERNS = [
  { id: 'filesystem-format', description: 'formats a filesystem', pattern: /\bmkfs(\.[a-z0-9]+)?\b/i },
  { id: 'raw-disk-write', description: 'writes raw data to a block device', pattern: /\bdd\b[^\n]*\bof=\s*\/dev\//i },
  { id: 'disk-partition', description: 'repartitions a disk', pattern: /\b(fdisk|sfdisk|cfdisk|parted|diskpart)\b/i },
  { id: 'redirect-to-device', description: 'redirects output into a block device', pattern: />>?\s*\/dev\/(sd|hd|vd|nvme|mmcblk|disk)/i },
  { id: 'host-power', description: 'powers off or reboots the machine', pattern: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { id: 'init-runlevel', description: 'changes the init runlevel', pattern: /\binit\s+[06]\b/i },
  { id: 'fork-bomb', description: 'starts a fork bomb', pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/ },
  { id: 'recursive-root-delete', description: 'recursively deletes a root or home path', pattern: /\brm\b(?=[^\n]*\s-[a-z]*r)(?=[^\n]*\s-[a-z]*f)[^\n]*\s(\/|\/\*|~|\$HOME|\$\{HOME\})(\s|$)/i },
  { id: 'chmod-root', description: 'recursively rewrites permissions on a root path', pattern: /\bchmod\b[^\n]*\s(\/|\/\*)(\s|$)/i },
  { id: 'chown-root', description: 'recursively rewrites ownership on a root path', pattern: /\bchown\b[^\n]*\s(\/|\/\*)(\s|$)/i },
  { id: 'history-rewrite', description: 'clears shell history to hide activity', pattern: /\b(history\s+-c|shred\b[^\n]*\.bash_history|>\s*~?\/?\.bash_history)/i },
  { id: 'windows-destructive', description: 'destroys Windows system state', pattern: /\b(format|diskpart|bcdedit|cipher\s+\/w)\b/i },
];

function normalize(command) {
  return String(command).replace(/\s+/g, ' ').trim();
}

export function checkCommand(command) {
  const normalized = normalize(command);
  const findings = [];
  for (const blocked of runtimeConfig.blockedCommands) {
    if (normalized.toLowerCase().includes(blocked.toLowerCase())) findings.push({ id: 'policy', description: blocked, source: 'device-policy' });
  }
  if (runtimeConfig.dangerousCommands !== 'allow') {
    for (const entry of DANGEROUS_PATTERNS) {
      if (entry.pattern.test(normalized)) findings.push({ id: entry.id, description: entry.description, source: 'builtin' });
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

export const dangerousPatternIds = DANGEROUS_PATTERNS.map(entry => entry.id);
