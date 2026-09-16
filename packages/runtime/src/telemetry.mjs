import process from 'node:process';
import { runtimeConfig } from './config.mjs';
import { VERSION } from './version.mjs';

// Event fields are whitelisted: an event can never carry a file path, a command
// string, tool arguments, or tool output. Only tool names, timings, outcomes and
// coarse error classes leave this process, and only through the paired ReMCP agent.
const EVENT_FIELDS = {
  tool: value => String(value).slice(0, 64),
  durationMs: value => Math.max(0, Math.round(Number(value))),
  success: value => value === true,
  errorKind: value => String(value).slice(0, 48),
  sessionKind: value => (value === 'process' || value === 'search' ? value : 'other'),
  reason: value => String(value).slice(0, 48),
  count: value => Math.max(0, Math.round(Number(value))),
};

const BUFFER_LIMIT = 250;
const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_THRESHOLD = 20;

const state = {
  enabled: runtimeConfig.telemetryEnabled,
  buffer: [],
  sink: null,
  timer: null,
  startedAt: Date.now(),
  dropped: 0,
  sent: 0,
  counters: {
    toolCalls: 0,
    toolFailures: 0,
    policyBlocks: 0,
    sessionsStarted: 0,
    searchesStarted: 0,
    bytesWritten: 0,
    writeDenials: 0,
  },
  toolCounts: new Map(),
};

export function telemetryEnabled() {
  return state.enabled;
}

export function telemetryStatus() {
  return {
    enabled: state.enabled,
    transport: 'paired-agent-only',
    endpoint: null,
    thirdParty: false,
    installPing: false,
    remoteFeatureFlags: false,
    buffered: state.buffer.length,
    sentEvents: state.sent,
    droppedEvents: state.dropped,
    counters: { ...state.counters },
    topTools: topTools(5),
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
  };
}

function topTools(limit) {
  return [...state.toolCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([tool, value]) => ({ tool, calls: value.count, failures: value.failures }));
}

function bump(tool, success) {
  state.counters.toolCalls += 1;
  if (!success) state.counters.toolFailures += 1;
  const entry = state.toolCounts.get(tool) || { count: 0, failures: 0 };
  entry.count += 1;
  if (!success) entry.failures += 1;
  state.toolCounts.set(tool, entry);
}

export function countEvent(name, amount = 1) {
  if (Object.hasOwn(state.counters, name)) state.counters[name] += Math.max(0, Math.round(Number(amount) || 0));
}

function sanitize(detail) {
  const clean = {};
  for (const [key, coerce] of Object.entries(EVENT_FIELDS)) {
    if (detail[key] === undefined || detail[key] === null) continue;
    const value = coerce(detail[key]);
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) continue;
    clean[key] = value;
  }
  return clean;
}

export function recordEvent(event, detail = {}) {
  const name = String(event).slice(0, 48);
  if (name === 'tool_call') bump(detail.tool ? String(detail.tool).slice(0, 64) : 'unknown', detail.success === true);
  if (name === 'policy_block') state.counters.policyBlocks += 1;
  if (name === 'session_started') state.counters.sessionsStarted += 1;
  if (name === 'write_denied') state.counters.writeDenials += 1;
  if (!state.enabled) return;
  if (state.buffer.length >= BUFFER_LIMIT) {
    state.dropped += 1;
    return;
  }
  state.buffer.push({ event: name, at: Date.now(), ...sanitize(detail) });
  if (state.buffer.length >= FLUSH_THRESHOLD) void flush();
}

export function setTelemetrySink(sink) {
  state.sink = typeof sink === 'function' ? sink : null;
  if (state.sink && !state.timer) {
    state.timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    state.timer.unref?.();
  }
}

export async function flush() {
  if (!state.sink || !state.buffer.length) return 0;
  const batch = state.buffer.splice(0, state.buffer.length);
  try {
    await state.sink({
      runtimeVersion: VERSION,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      name: runtimeConfig.name,
      events: batch,
    });
    state.sent += batch.length;
    return batch.length;
  } catch {
    // Never lose the process over telemetry, and never grow without bound either.
    state.dropped += batch.length;
    return 0;
  }
}

export function shutdownTelemetry() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  try { state.sink?.({ runtimeVersion: VERSION, platform: process.platform, arch: process.arch, name: runtimeConfig.name, events: state.buffer.splice(0, state.buffer.length) }); } catch {}
}

export function resetTelemetryForTests() {
  state.buffer.length = 0;
  state.dropped = 0;
  state.sent = 0;
  state.sink = null;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  state.toolCounts.clear();
  for (const key of Object.keys(state.counters)) state.counters[key] = 0;
}
