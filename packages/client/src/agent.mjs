import os from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeRuntime } from './runtime.mjs';
import { VERSION } from './version.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const METRICS_INTERVAL_MS = 60_000;
const TELEMETRY_QUEUE_LIMIT = 500;
const TELEMETRY_BATCH_LIMIT = 100;
const TELEMETRY_SEND_INTERVAL_MS = 5_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const RUNTIME_RESTART_BASE_MS = 1_000;
const RUNTIME_RESTART_MAX_MS = 30_000;
// Below the relay's RPC timeout so the model gets a real error instead of a client-side
// timeout while the device keeps working invisibly.
const CALL_TIMEOUT_MARGIN_MS = 10_000;

function globalNodeModules() {
  const result = spawnSync(npmCommand, ['root', '--global'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Could not locate the global npm modules directory');
  return String(result.stdout || '').trim();
}

function localRuntimeEntry(runtimeValue) {
  const runtime = normalizeRuntime(runtimeValue);
  const candidate = path.join(globalNodeModules(), ...runtime.packageName.split('/'), ...runtime.entry.split(/[\\/]+/));
  if (!existsSync(candidate)) throw new Error('ReMCP local runtime is not installed. Run `remcp install`.');
  return candidate;
}

function jitter(ms) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

// Device health is sampled locally and is the only thing ReMCP stores about the machine
// beyond its name, platform and last-seen time. No process list, no file names.
function deviceMetrics(extra = {}) {
  const load = os.loadavg?.()[0] ?? 0;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    uptimeSeconds: Math.round(os.uptime()),
    agentUptimeSeconds: Math.round(process.uptime()),
    rssBytes: process.memoryUsage().rss,
    load1: Number.isFinite(load) ? Number(load.toFixed(2)) : 0,
    cpuCount: os.cpus?.().length ?? 0,
    freeMemoryRatio: totalMem > 0 ? Number((freeMem / totalMem).toFixed(3)) : 0,
    agentVersion: VERSION,
    ...extra,
  };
}

export async function runAgent(options) {
  const serverUrl = String(options.serverUrl || '').replace(/\/$/, '');
  const deviceToken = String(options.deviceToken || '');
  const deviceId = String(options.deviceId || '');
  const deviceName = String(options.deviceName || os.hostname());
  if (!serverUrl || !deviceToken || !deviceId) throw new Error('serverUrl, deviceToken and deviceId are required');
  const agentUrl = serverUrl.replace(/^http/, 'ws') + '/agent';
  const callTimeoutMs = Math.max(5_000, Number(options.rpcTimeoutMs || 120000) - CALL_TIMEOUT_MARGIN_MS);
  const telemetryEnabled = options.telemetryEnabled !== false;
  const persistState = typeof options.persistState === 'function' ? options.persistState : () => {};
  let stopping = false;
  let activeSocket;
  let reconnects = 0;
  let pendingRequests = 0;
  let runtimeVersion = 'unknown';
  let runtimeRestarts = 0;
  let runtimeDown = false;
  const telemetryQueue = [];
  let telemetryTimer = null;
  const runtimeEntry = localRuntimeEntry(options.runtime);

  // --- local runtime supervision ------------------------------------------------------
  // If the runtime dies (a bad shell, a broken pipe, an OOM) the agent used to stay
  // "online" forever and every later call failed with an opaque "Not connected". Now the
  // transport is watched and the runtime is restarted with backoff.
  let mcp = null;
  let transport = null;
  let runtimeRestartDelay = RUNTIME_RESTART_BASE_MS;

  function runtimeEnv() {
    // The SDK's stdio transport does not inherit the environment by default; spreading
    // process.env here is what gives the runtime its REMCP_RUNTIME_* configuration, PATH,
    // HOME and the telemetry opt-out.
    const env = { ...process.env };
    if (!telemetryEnabled) env.REMCP_RUNTIME_DISABLE_TELEMETRY = '1';
    return env;
  }

  async function startRuntime() {
    if (stopping) return;
    runtimeDown = false;
    const client = new Client({ name: 'remcp-agent', version: VERSION });
    const stdio = new StdioClientTransport({ command: process.execPath, args: [runtimeEntry], env: runtimeEnv() });
    mcp = client;
    transport = stdio;
    client.fallbackNotificationHandler = async notification => {
      if (!telemetryEnabled) return;
      if (notification?.method !== 'notifications/remcp/telemetry') return;
      const events = Array.isArray(notification.params?.events) ? notification.params.events : [];
      if (!events.length) return;
      if (notification.params?.runtimeVersion) runtimeVersion = String(notification.params.runtimeVersion);
      for (const event of events) {
        if (telemetryQueue.length >= TELEMETRY_QUEUE_LIMIT) telemetryQueue.shift();
        telemetryQueue.push(event);
      }
    };
    stdio.onclose = () => handleRuntimeExit('closed');
    stdio.onerror = error => console.error(`ReMCP local runtime error: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await client.connect(stdio);
      runtimeVersion = client.getServerVersion()?.version || runtimeVersion;
      runtimeRestarts += 1;
      runtimeRestartDelay = RUNTIME_RESTART_BASE_MS;
      console.log(`ReMCP local runtime ready (${runtimeVersion})`);
      send({ type: 'metrics', metrics: deviceMetrics({ reconnects, pendingRequests, runtimeVersion, runtimeRestarts, runtimeDown: false }) });
      if (runtimeRestarts > 1) queueEvent({ event: 'runtime_restart', at: Date.now(), count: runtimeRestarts, success: true });
    } catch (error) {
      console.error(`ReMCP local runtime failed to start: ${error instanceof Error ? error.message : String(error)}`);
      handleRuntimeExit('failed');
    }
  }

  function handleRuntimeExit(reason) {
    if (stopping || runtimeDown) return;
    runtimeDown = true;
    const delay = jitter(runtimeRestartDelay);
    runtimeRestartDelay = Math.min(RUNTIME_RESTART_MAX_MS, runtimeRestartDelay * 2);
    console.error(`ReMCP local runtime ${reason}; restarting in ${delay}ms`);
    queueEvent({ event: 'runtime_down', at: Date.now(), reason: reason.slice(0, 24) });
    send({ type: 'metrics', metrics: deviceMetrics({ reconnects, pendingRequests, runtimeVersion, runtimeRestarts, runtimeDown: true }) });
    setTimeout(() => { void startRuntime(); }, delay).unref?.();
  }

  // --- relay connection ---------------------------------------------------------------
  function send(message) {
    if (activeSocket?.readyState === 1) {
      activeSocket.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function flushTelemetry() {
    if (!telemetryEnabled || !telemetryQueue.length) return;
    const batch = telemetryQueue.splice(0, TELEMETRY_BATCH_LIMIT);
    if (!send({ type: 'telemetry', runtimeVersion, agentVersion: VERSION, events: batch })) telemetryQueue.unshift(...batch);
  }

  function queueEvent(event) {
    if (!telemetryEnabled) return;
    if (telemetryQueue.length >= TELEMETRY_QUEUE_LIMIT) telemetryQueue.shift();
    telemetryQueue.push(event);
  }

  function reportInstallOnce() {
    if (!telemetryEnabled || options.installReported === true) return;
    if (send({
      type: 'install',
      agentVersion: VERSION,
      runtimeVersion,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      installSpec: String(options.installSpec || ''),
    })) {
      persistState({ installReported: true });
      console.log('ReMCP reported this installation to your own workspace (disable with `remcp telemetry off`).');
    }
  }

  async function respond(ws, message) {
    pendingRequests += 1;
    try {
      let result;
      if (message.method === 'ping') {
        result = { ok: true, hostname: os.hostname(), platform: process.platform, arch: process.arch, uptimeSeconds: Math.floor(os.uptime()), agentVersion: VERSION, runtimeVersion, runtimeRestarts };
      } else if (!runtimeDown && mcp) {
        if (message.method === 'tools/list') result = await mcp.listTools(undefined, { timeout: callTimeoutMs });
        else if (message.method === 'tools/call') result = await mcp.callTool(message.params, undefined, { timeout: callTimeoutMs });
        else throw new Error(`Unsupported relay method: ${message.method}`);
      } else {
        throw new Error('The ReMCP local runtime is restarting. Retry in a few seconds.');
      }
      ws.send(JSON.stringify({ type: 'response', id: message.id, result }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'response', id: message.id, error: { message: error instanceof Error ? error.message : String(error) } }));
    } finally {
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  }

  function connect() {
    if (stopping) return;
    const ws = new WebSocket(agentUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });
    activeSocket = ws;
    ws.on('open', () => {
      reconnects = 0;
      ws.send(JSON.stringify({
        type: 'hello',
        deviceId,
        deviceName,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        agentVersion: VERSION,
        runtimeVersion,
        telemetryEnabled,
        reconnects,
      }));
      console.log(`Connected to ${serverUrl} as ${deviceName}`);
      send({ type: 'metrics', metrics: deviceMetrics({ reconnects, pendingRequests, runtimeVersion, runtimeRestarts, runtimeDown }) });
      reportInstallOnce();
      flushTelemetry();
    });
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'request') void respond(ws, message);
    });
    ws.on('close', code => {
      if (stopping) return;
      if (code === 1008) {
        // The relay closes with 1008 when the device was revoked. Retrying forever would
        // hide that from the person at the computer.
        console.error('ReMCP access for this device was revoked. Pair the machine again from the ReMCP workspace: remcp connect --server <url> --code <code> --install');
        return;
      }
      reconnects += 1;
      const delay = jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnects, 5)));
      setTimeout(connect, delay);
    });
    ws.on('error', error => console.error(`ReMCP relay: ${error.message}`));
  }

  telemetryTimer = setInterval(() => {
    if (activeSocket?.readyState === 1) {
      send({ type: 'metrics', metrics: deviceMetrics({ reconnects, pendingRequests, runtimeVersion, runtimeRestarts, runtimeDown, queueDepth: telemetryQueue.length }) });
      flushTelemetry();
    }
  }, METRICS_INTERVAL_MS);
  telemetryTimer.unref?.();
  const telemetryFlushTimer = setInterval(flushTelemetry, TELEMETRY_SEND_INTERVAL_MS);
  telemetryFlushTimer.unref?.();

  async function stop() {
    if (stopping) return;
    stopping = true;
    if (telemetryTimer) clearInterval(telemetryTimer);
    clearInterval(telemetryFlushTimer);
    try { activeSocket?.close(); } catch {}
    try { await mcp?.close(); } catch {}
    try { await transport?.close(); } catch {}
  }

  process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
  await startRuntime();
  connect();
  return { stop, runtimeVersion: () => runtimeVersion, runtimeRestarts: () => runtimeRestarts, isRuntimeDown: () => runtimeDown };
}
