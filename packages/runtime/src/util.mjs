import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { runtimeConfig } from './config.mjs';

export class ToolError extends Error {}

export function fail(message) {
  throw new ToolError(String(message));
}

export function expandHome(value) {
  const text = String(value ?? '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required`);
  return value.trim();
}

export function requireInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${field} must be a positive integer`);
  return parsed;
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function resolveInputPath(value, field = 'path') {
  const raw = expandHome(requireString(value, field));
  if (raw.includes('\0')) fail(`${field} contains an invalid character`);
  const absolute = path.resolve(raw);
  if (runtimeConfig.allowedRoots.length && !isInsideAnyRoot(absolute)) {
    fail(`Path is outside the directories this device allows: ${runtimeConfig.allowedRoots.join(', ')}`);
  }
  return absolute;
}

export function isInsideRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function isInsideAnyRoot(candidate) {
  return runtimeConfig.allowedRoots.some(root => isInsideRoot(candidate, root));
}

// Resolve symlinks for the deepest path segment that exists, then re-append the
// segments that do not exist yet. A lexical prefix check alone is not enough:
// `<allowed>/link -> /etc` would otherwise pass the allowlist and read /etc.
export async function canonicalizePath(target) {
  let current = path.resolve(target);
  const missing = [];
  for (;;) {
    try {
      const resolved = await realpath(current);
      return missing.length ? path.join(resolved, ...missing) : resolved;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return missing.length ? path.join(current, ...missing) : current;
      const parent = path.dirname(current);
      if (parent === current) return missing.length ? path.join(current, ...missing) : current;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

let resolvedRootsPromise;
function resolvedRoots() {
  if (!resolvedRootsPromise) {
    resolvedRootsPromise = Promise.all(runtimeConfig.allowedRoots.map(async root => {
      try { return await realpath(root); } catch { return root; }
    }));
  }
  return resolvedRootsPromise;
}

// Canonical, allowlist-checked path for every file tool. The canonical path is what
// callers must use, so a symlink cannot be swapped between the check and the access.
export async function resolveSafePath(value, field = 'path') {
  const absolute = resolveInputPath(value, field);
  if (!runtimeConfig.allowedRoots.length) return absolute;
  const canonical = await canonicalizePath(absolute);
  const roots = await resolvedRoots();
  if (!roots.some(root => isInsideRoot(canonical, root))) {
    fail(`Path resolves outside the directories this device allows: ${runtimeConfig.allowedRoots.join(', ')}`);
  }
  return canonical;
}

export function displayPath(absolute) {
  const home = os.homedir();
  return absolute.startsWith(home + path.sep) ? `~/${absolute.slice(home.length + 1)}` : absolute;
}

export function truncate(text, maxBytes) {
  const limit = maxBytes || runtimeConfig.maxOutputBytes;
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  const head = buffer.subarray(0, Math.floor(limit * 0.7)).toString('utf8');
  const tail = buffer.subarray(buffer.length - Math.floor(limit * 0.2)).toString('utf8');
  return `${head}\n… output truncated (${buffer.length} bytes, limit ${limit}) …\n${tail}`;
}

export function text(value, isError = false) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: truncate(body) }], ...(isError ? { isError: true } : {}) };
}

export function splitLines(value) {
  const normalized = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

export function pageLines(lines, offset, length) {
  const total = lines.length;
  const requested = Math.trunc(offset || 0);
  if (requested < 0) {
    const count = Math.min(Math.abs(requested), total);
    return { start: total - count, end: total, slice: lines.slice(total - count) };
  }
  const start = Math.min(requested, total);
  const end = Math.min(start + Math.max(1, Math.trunc(length || runtimeConfig.maxReadLines)), total);
  return { start, end, slice: lines.slice(start, end) };
}

export function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}
