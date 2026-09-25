import os from 'node:os';
import path from 'node:path';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { expandHome } from './util.mjs';

const configDir = process.env.REMCP_RUNTIME_CONFIG_DIR || path.join(os.homedir(), '.config', 'remcp');
export const runtimeConfigPath = path.join(configDir, 'runtime.json');
export const runtimeConfigDir = configDir;

// The MCP SDK's stdio client closes the connection on a message above 10 MB, which kills
// this process. Keep the runtime's own output cap well below that so raising an env var
// cannot turn a large tool result into a dead device.
export const HARD_OUTPUT_CEILING_BYTES = 8 * 1024 * 1024;

let configError = null;

function readConfigFile() {
  let raw;
  try {
    raw = readFileSync(runtimeConfigPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    configError = `Could not read ${runtimeConfigPath}: ${error instanceof Error ? error.message : String(error)}`;
    return {};
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      configError = `${runtimeConfigPath} must contain a JSON object`;
      return {};
    }
    return parsed;
  } catch (error) {
    // A trailing comma used to silently drop allowedRoots and re-enable usage metrics.
    configError = `${runtimeConfigPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
    return {};
  }
}

const file = readConfigFile();

function stringList(value, fallback = []) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : fallback;
  return source.map(item => String(item).trim()).filter(Boolean);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

const DANGEROUS_MODES = ['block', 'warn', 'allow'];

// `block` is the secure default: matching catastrophic commands are refused before execution.
// Operators can explicitly choose `warn` to run with an advisory note or `allow` for zero guardrail noise.
function dangerousMode(value, fallback = 'block') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return DANGEROUS_MODES.includes(normalized) ? normalized : fallback;
}

const allowedRoots = stringList(process.env.REMCP_RUNTIME_ALLOWED_ROOTS ?? file.allowedRoots)
  .map(root => path.resolve(expandHome(root)));

// "Everything is allowed" mode. It is deliberately *not* settable through MCP: a model that could
// widen its own reach would turn any prompt injection into root. The person at the computer turns it
// on (environment variable, runtime.json, or `remcp godmode on`), and the runtime then reports it in
// get_runtime_info so the model and the workspace can say so out loud.
//
// What it changes: no access-root confinement (allowedRoots becomes empty, which the path resolver
// already reads as "the whole filesystem"), the configured command blocklist is ignored, and the
// catastrophic-command guardrail is set to `allow`. What it does not change: the per-call size limits
// (maxWriteBytes, maxOutputBytes, line limits) — they bound one call, not what a person may do — and
// the fact that commands run as the user the agent runs as. To act as root, run the agent as root
// (`sudo remcp install --system`) or start it under sudo.
const unrestricted = booleanValue(process.env.REMCP_RUNTIME_UNRESTRICTED, booleanValue(file.unrestricted, false));

// Telemetry is opt-out, matching the ReMCP client: it is on unless the user (or the
// ReMCP agent that spawned this runtime) turns it off. It never sends file paths,
// command strings, arguments, or tool output - only tool names, timings and outcomes.
const telemetryDisabled = booleanValue(process.env.REMCP_RUNTIME_DISABLE_TELEMETRY, false);
const telemetryEnabled = telemetryDisabled
  ? false
  : booleanValue(process.env.REMCP_RUNTIME_TELEMETRY ?? file.telemetryEnabled, true);

// 2 MiB of tool result per call by default: enough for a large file read or a batch of
// files, still comfortably below the transport ceiling.
const configuredOutputBytes = positiveNumber(process.env.REMCP_RUNTIME_MAX_OUTPUT_BYTES ?? file.maxOutputBytes, 2 * 1024 * 1024);

export const runtimeConfig = Object.freeze({
  unrestricted,
  allowedRoots: Object.freeze(unrestricted ? [] : allowedRoots),
  blockedCommands: Object.freeze(unrestricted ? [] : stringList(process.env.REMCP_RUNTIME_BLOCKED_COMMANDS ?? file.blockedCommands)),
  dangerousCommands: unrestricted ? 'allow' : dangerousMode(process.env.REMCP_RUNTIME_DANGEROUS_COMMANDS ?? file.dangerousCommands),
  maxOutputBytes: Math.min(configuredOutputBytes, HARD_OUTPUT_CEILING_BYTES),
  maxReadLines: positiveNumber(process.env.REMCP_RUNTIME_MAX_READ_LINES ?? file.maxReadLines, 4000),
  maxBufferedLines: positiveNumber(process.env.REMCP_RUNTIME_MAX_BUFFERED_LINES ?? file.maxBufferedLines, 100000),
  maxWriteBytes: positiveNumber(process.env.REMCP_RUNTIME_MAX_WRITE_BYTES ?? file.maxWriteBytes, 8 * 1024 * 1024),
  defaultShell: String(process.env.REMCP_RUNTIME_SHELL || file.defaultShell || '').trim(),
  name: String(process.env.REMCP_RUNTIME_NAME || file.name || os.hostname()).trim(),
  telemetryEnabled,
});

// --- settings a model may change, and nothing else ------------------------------------------------
//
// Desktop Commander lets a model rewrite any of its own configuration, including the directories it
// may touch and the commands it must refuse. On ReMCP those two decide what the computer exposes, so
// they stay with the person at the computer: `allowedRoots`, `blockedCommands`, `dangerousCommands`
// (the command guardrail), `defaultShell`, `maxWriteBytes` and `name` are not settable from a tool.
//
// What is settable is a preference and two context limits — telemetry opt-out, the read and buffer
// line limits, and the result size — all of which the person can also change in runtime.json. The
// values apply immediately (the tool handlers read them through liveConfig) and are written back to
// runtime.json so they survive a restart.
const SETTABLE = Object.freeze({
  telemetryEnabled: { type: 'boolean' },
  maxReadLines: { type: 'integer', min: 1, max: 100_000 },
  maxBufferedLines: { type: 'integer', min: 1, max: 1_000_000 },
  maxOutputBytes: { type: 'integer', min: 1024, max: HARD_OUTPUT_CEILING_BYTES },
});
export const settableKeys = Object.freeze(Object.keys(SETTABLE));

const live = new Map();

// Every read of a settable value goes through here, so a change applies to the next call.
export function liveConfig(key) {
  return live.has(key) ? live.get(key) : runtimeConfig[key];
}

export function validateConfigValue(key, raw) {
  const rule = SETTABLE[key];
  if (!rule) {
    throw new Error(`Unsupported setting: ${key || '(empty)'}. Settable here: ${settableKeys.join(', ')}. Access roots, blocked commands, the command guardrail, the shell and write limits are changed by the person at this computer.`);
  }
  if (rule.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') return booleanValue(raw, null) ?? (() => { throw new Error(`${key} must be true or false`); })();
    throw new Error(`${key} must be true or false`);
  }
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  if (value < rule.min || value > rule.max) throw new Error(`${key} must be between ${rule.min} and ${rule.max}`);
  return value;
}

export function applyLiveConfig(key, value) {
  live.set(key, value);
}

// Writes only the changed key back, with the file mode the rest of the runtime expects.
export function persistConfigValue(key, value) {
  const file = readConfigFile();
  const next = { ...file, [key]: value };
  mkdirSync(runtimeConfigDir, { recursive: true, mode: 0o700 });
  const existing = lstatSync(runtimeConfigPath, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('runtime configuration path must be a regular file');
  const temporary = `${runtimeConfigPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, runtimeConfigPath);
    chmodSync(runtimeConfigPath, 0o600);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  return runtimeConfigPath;
}

// A configuration the user cannot read is not a configuration we should quietly ignore:
// it is how allowedRoots and an opt-out silently disappear.
export function configurationError() {
  return configError;
}

export function describeConfig() {
  return {
    name: runtimeConfig.name,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    configFile: runtimeConfigPath,
    configError,
    allowedRoots: [...runtimeConfig.allowedRoots],
    blockedCommands: [...runtimeConfig.blockedCommands],
    dangerousCommands: runtimeConfig.dangerousCommands,
    maxOutputBytes: runtimeConfig.maxOutputBytes,
    maxOutputBytesCeiling: HARD_OUTPUT_CEILING_BYTES,
    maxReadLines: runtimeConfig.maxReadLines,
    maxBufferedLines: runtimeConfig.maxBufferedLines,
    maxWriteBytes: runtimeConfig.maxWriteBytes,
    defaultShell: runtimeConfig.defaultShell || null,
    telemetryEnabled: runtimeConfig.telemetryEnabled,
    telemetryTransport: 'paired-agent-only',
  };
}
