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

export async function runAgent(options) {
  const serverUrl = String(options.serverUrl || '').replace(/\/$/, '');
  const deviceToken = String(options.deviceToken || '');
  const deviceId = String(options.deviceId || '');
  const deviceName = String(options.deviceName || os.hostname());
  if (!serverUrl || !deviceToken || !deviceId) throw new Error('serverUrl, deviceToken and deviceId are required');
  const agentUrl = serverUrl.replace(/^http/, 'ws') + '/agent';
  const reconnectMs = Number(options.reconnectMs || 3000);
  let stopping = false;
  let activeSocket;

  const mcp = new Client({ name: 'remcp-agent', version: VERSION });
  const transport = new StdioClientTransport({ command: process.execPath, args: [localRuntimeEntry(options.runtime)] });
  await mcp.connect(transport);
  console.log('ReMCP local runtime ready');

  async function respond(ws, message) {
    try {
      let result;
      if (message.method === 'tools/list') result = await mcp.listTools();
      else if (message.method === 'tools/call') result = await mcp.callTool(message.params);
      else if (message.method === 'ping') result = { ok: true, hostname: os.hostname(), platform: process.platform, arch: process.arch, uptimeSeconds: Math.floor(os.uptime()) };
      else throw new Error(`Unsupported relay method: ${message.method}`);
      ws.send(JSON.stringify({ type: 'response', id: message.id, result }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'response', id: message.id, error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  }

  function connect() {
    if (stopping) return;
    const ws = new WebSocket(agentUrl, { headers: { Authorization: `Bearer ${deviceToken}` } });
    activeSocket = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', deviceId, deviceName, hostname: os.hostname(), platform: process.platform, arch: process.arch, agentVersion: VERSION }));
      console.log(`Connected to ${serverUrl} as ${deviceName}`);
    });
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message?.type === 'request') void respond(ws, message);
    });
    ws.on('close', () => { if (!stopping) setTimeout(connect, reconnectMs); });
    ws.on('error', error => console.error(`ReMCP relay: ${error.message}`));
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    try { activeSocket?.close(); } catch {}
    try { await mcp.close(); } catch {}
    try { await transport.close(); } catch {}
  }

  process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
  connect();
  return { stop };
}
