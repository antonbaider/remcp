import os from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeRuntime } from './runtime.mjs';
import { VERSION } from './version.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5000;
// A version that failed to install is retried after this cooldown instead of on every reconnect.
const UPDATE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const METRICS_INTERVAL_MS = 60_000;
const TELEMETRY_QUEUE_LIMIT = 500;
const TELEMETRY_BATCH_LIMIT = 100;
const TELEMETRY_SEND_INTERVAL_MS = 5_000;
const RECONNECT_BASE_MS = 2_000;
// Must stay above the runtime's own output ceiling (8 MiB), otherwise a large but legal tool result
// closes the stdio connection and restarts the runtime mid-call.
const RUNTIME_STDIO_BUFFER_BYTES = 24 * 1024 * 1024;
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

function parseVersion(value) {
  // Prerelease and build metadata are kept, because comparing only the numeric core made
  // 1.0.0 look newer than 1.0.0-beta.2 and left a machine stuck on the prerelease forever.
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return match ? { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || '' } : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] > b.parts[index]) return true;
    if (a.parts[index] < b.parts[index]) return false;
  }
  // Same numeric core: a release is newer than a prerelease, and two prereleases compare by
  // identifier (numeric identifiers order numerically, as semver requires).
  if (!a.prerelease && b.prerelease) return true;
  if (a.prerelease && !b.prerelease) return false;
  if (!a.prerelease && !b.prerelease) return false;
  const left = a.prerelease.split('.');
  const right = b.prerelease.split('.');
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index];
    const two = right[index];
    if (one === undefined) return false;
    if (two === undefined) return true;
    if (one === two) continue;
    const oneNumeric = /^\d+$/.test(one);
    const twoNumeric = /^\d+$/.test(two);
    if (oneNumeric && twoNumeric) return Number(one) > Number(two);
    if (oneNumeric !== twoNumeric) return oneNumeric;
    return one > two;
  }
  return false;
}

function globalCliEntry() {
  const prefix = spawnSync(npmCommand, ['prefix', '--global'], { encoding: 'utf8' });
  if (prefix.error || prefix.status !== 0) return null;
  const base = String(prefix.stdout || '').trim();
  return process.platform === 'win32'
    ? path.join(base, 'remcp.cmd')
    : path.join(base, 'bin', 'remcp');
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
  let revoked = false;
  const inFlight = new Map();
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
    const stdio = new StdioClientTransport({ command: process.execPath, args: [runtimeEntry], env: runtimeEnv(), maxBufferSize: RUNTIME_STDIO_BUFFER_BYTES });
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
    // The relay forwards a cancel when the MCP client goes away. Without it a cancelled tool call
    // kept running on the machine (a delete still deleted), because nothing told the runtime.
    const controller = new AbortController();
    inFlight.set(message.id, controller);
    try {
      let result;
      if (message.method === 'ping') {
        result = { ok: true, hostname: os.hostname(), platform: process.platform, arch: process.arch, uptimeSeconds: Math.floor(os.uptime()), agentVersion: VERSION, runtimeVersion, runtimeRestarts };
      } else if (!runtimeDown && mcp) {
        const options = { timeout: callTimeoutMs, signal: controller.signal };
        if (message.method === 'tools/list') result = await mcp.listTools(undefined, options);
        else if (message.method === 'tools/call') result = await mcp.callTool(message.params, undefined, options);
        else throw new Error(`Unsupported relay method: ${message.method}`);
      } else {
        throw new Error('The ReMCP local runtime is restarting. Retry in a few seconds.');
      }
      ws.send(JSON.stringify({ type: 'response', id: message.id, result }));
    } catch (error) {
      const cancelled = controller.signal.aborted;
      ws.send(JSON.stringify({ type: 'response', id: message.id, error: { message: cancelled ? 'Cancelled: the client stopped waiting for this call.' : error instanceof Error ? error.message : String(error) } }));
    } finally {
      inFlight.delete(message.id);
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  }

  function connect() {
    if (stopping) return;
    const ws = new WebSocket(agentUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });
    // A revoked device is refused during the handshake with a 401 and this header, because a bare
    // rejection looked like a network problem (close 1006) and the agent retried it forever.
    ws.on('unexpected-response', (_request, response) => {
      if (String(response.headers['x-remcp-revoked'] || '') === '1') revoked = true;
      console.error(`ReMCP relay refused the connection (HTTP ${response.statusCode})${revoked ? ': this device was revoked' : ''}.`);
      response.resume();
    });
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
      void checkForUpdate();
    });
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'request') void respond(ws, message);
      if (message?.type === 'cancel' && message.id) {
        const controller = inFlight.get(message.id);
        if (controller) controller.abort();
      }
    });
    ws.on('close', code => {
      if (stopping) return;
      if (code === 1008 || revoked) {
        // The relay closes with 1008 when the device was revoked. Retrying forever would
        // hide that from the person at the computer.
        console.error('ReMCP access for this device was revoked. Pair the machine again from the ReMCP workspace: remcp connect --server <url> --code <code> --install');
        return;
      }
      if (code === 1012) {
        // 1012 ('service restart') is what the relay sends when another agent process took over
        // this device. Reconnecting immediately produced two agents evicting each other in a loop,
        // so back off and let the surviving process keep the connection.
        console.error('Another ReMCP agent connected for this device; this process will stop. Run one agent per machine (systemd service or `remcp start`).');
        return;
      }
      reconnects += 1;
      const delay = jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnects, 5)));
      setTimeout(connect, delay);
    });
    ws.on('error', error => console.error(`ReMCP relay: ${error.message}`));
  }

  // Auto-update: the server publishes the versions an agent should be running. A newer
  // release is installed in the background and the service restart picks it up; a failed
  // or skipped update leaves the current version running, so an old agent keeps working.
  //
  // The update must be idempotent across reconnects: a flapping relay used to start one
  // `npm install -g` per reconnect, so a machine could run several installers (and service
  // restarts) at once. One attempt per advertised version, and never two at the same time.
  let updateInFlight = false;
  let lastAttemptedVersion = '';
  let lastAttemptAt = 0;
  async function checkForUpdate() {
    if (options.autoUpdate === false) return;
    if (updateInFlight) return;
    try {
      const response = await fetch(`${serverUrl}/api/agent/version`, { signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
      if (!response.ok) return;
      const advertised = await response.json();
      const minimum = advertised.minimum;
      if (minimum && isNewer(minimum, VERSION)) {
        console.error(`ReMCP ${VERSION} is older than the minimum supported agent ${minimum}; update with: remcp update`);
      }
      if (!isNewer(advertised.cli, VERSION)) return;
      const target = String(advertised.cli);
      queueEvent({ event: 'agent_update', at: Date.now(), reason: target.slice(0, 32), success: true });
      const cli = globalCliEntry();
      if (!cli || !existsSync(cli)) {
        console.error(`ReMCP ${target} is available; run: remcp update`);
        return;
      }
      // A version that already failed to install is retried only after a cooldown, so a broken
      // release cannot turn into an install loop.
      if (target === lastAttemptedVersion && Date.now() - lastAttemptAt < UPDATE_RETRY_COOLDOWN_MS) return;
      lastAttemptedVersion = target;
      lastAttemptAt = Date.now();
      updateInFlight = true;
      console.log(`Updating ReMCP to ${target}${advertised.runtime ? ` with ${advertised.runtime}` : ''}…`);
      const child = spawn(process.execPath, [cli, 'update', '--trust-runtime', ...(advertised.runtime ? ['--runtime', advertised.runtime] : [])], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.on('exit', () => { updateInFlight = false; });
      child.on('error', () => { updateInFlight = false; });
      child.unref();
    } catch {
      // Offline, DNS failure, older server without the endpoint: keep running as-is.
    }
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
  const updateTimer = setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
  updateTimer.unref?.();

  async function stop() {
    if (stopping) return;
    stopping = true;
    if (telemetryTimer) clearInterval(telemetryTimer);
    clearInterval(telemetryFlushTimer);
    clearInterval(updateTimer);
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
