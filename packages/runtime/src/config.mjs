import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { expandHome } from './util.mjs';

const configDir = process.env.REMCP_RUNTIME_CONFIG_DIR || path.join(os.homedir(), '.config', 'remcp');
export const runtimeConfigPath = path.join(configDir, 'runtime.json');
export const runtimeConfigDir = configDir;

function readConfigFile() {
  try { return JSON.parse(readFileSync(runtimeConfigPath, 'utf8')); } catch { return {}; }
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

function dangerousMode(value, fallback = 'block') {
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

export const runtimeConfig = Object.freeze({
  allowedRoots: Object.freeze(allowedRoots),
  blockedCommands: Object.freeze(stringList(process.env.REMCP_RUNTIME_BLOCKED_COMMANDS ?? file.blockedCommands)),
  dangerousCommands: dangerousMode(process.env.REMCP_RUNTIME_DANGEROUS_COMMANDS ?? file.dangerousCommands),
  maxOutputBytes: positiveNumber(process.env.REMCP_RUNTIME_MAX_OUTPUT_BYTES ?? file.maxOutputBytes, 1024 * 1024),
  maxReadLines: positiveNumber(process.env.REMCP_RUNTIME_MAX_READ_LINES ?? file.maxReadLines, 2000),
  maxBufferedLines: positiveNumber(process.env.REMCP_RUNTIME_MAX_BUFFERED_LINES ?? file.maxBufferedLines, 50000),
  maxWriteBytes: positiveNumber(process.env.REMCP_RUNTIME_MAX_WRITE_BYTES ?? file.maxWriteBytes, 8 * 1024 * 1024),
  defaultShell: String(process.env.REMCP_RUNTIME_SHELL || file.defaultShell || '').trim(),
  name: String(process.env.REMCP_RUNTIME_NAME || file.name || os.hostname()).trim(),
  telemetryEnabled,
});

export function describeConfig() {
  return {
    name: runtimeConfig.name,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    configFile: runtimeConfigPath,
    allowedRoots: [...runtimeConfig.allowedRoots],
    blockedCommands: [...runtimeConfig.blockedCommands],
    dangerousCommands: runtimeConfig.dangerousCommands,
    maxOutputBytes: runtimeConfig.maxOutputBytes,
    maxReadLines: runtimeConfig.maxReadLines,
    maxBufferedLines: runtimeConfig.maxBufferedLines,
    maxWriteBytes: runtimeConfig.maxWriteBytes,
    defaultShell: runtimeConfig.defaultShell || null,
    telemetryEnabled: runtimeConfig.telemetryEnabled,
    telemetryTransport: 'paired-agent-only',
  };
}
