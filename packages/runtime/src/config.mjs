import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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

// `warn` runs the command and adds a note when it matches the destructive-command list:
// nothing is ever blocked or delayed, but a catastrophic command is visible in the tool
// result. Set `allow` for zero noise or `block` to refuse.
function dangerousMode(value, fallback = 'warn') {
  const normalized = String(value ?? '').trim().toLowerCase();
  return DANGEROUS_MODES.includes(normalized) ? normalized : fallback;
}

const allowedRoots = stringList(process.env.REMCP_RUNTIME_ALLOWED_ROOTS ?? file.allowedRoots)
  .map(root => path.resolve(expandHome(root)));

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
  allowedRoots: Object.freeze(allowedRoots),
  blockedCommands: Object.freeze(stringList(process.env.REMCP_RUNTIME_BLOCKED_COMMANDS ?? file.blockedCommands)),
  dangerousCommands: dangerousMode(process.env.REMCP_RUNTIME_DANGEROUS_COMMANDS ?? file.dangerousCommands),
  maxOutputBytes: Math.min(configuredOutputBytes, HARD_OUTPUT_CEILING_BYTES),
  maxReadLines: positiveNumber(process.env.REMCP_RUNTIME_MAX_READ_LINES ?? file.maxReadLines, 4000),
  maxBufferedLines: positiveNumber(process.env.REMCP_RUNTIME_MAX_BUFFERED_LINES ?? file.maxBufferedLines, 100000),
  maxWriteBytes: positiveNumber(process.env.REMCP_RUNTIME_MAX_WRITE_BYTES ?? file.maxWriteBytes, 8 * 1024 * 1024),
  defaultShell: String(process.env.REMCP_RUNTIME_SHELL || file.defaultShell || '').trim(),
  name: String(process.env.REMCP_RUNTIME_NAME || file.name || os.hostname()).trim(),
  telemetryEnabled,
});

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
