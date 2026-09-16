#!/usr/bin/env node
import process from 'node:process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions, toolHandlers } from './catalog.mjs';
import { describeConfig, runtimeConfigDir } from './config.mjs';
import { invokeTool } from './invoke.mjs';
import { shutdownSessions, startSessionSweeper } from './sessions.mjs';
import { flush, setTelemetrySink, shutdownTelemetry, telemetryEnabled } from './telemetry.mjs';
import { VERSION } from './version.mjs';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write([
    'ReMCP local device runtime',
    '',
    'Usage: remcp-runtime [--print-tools] [--describe] [--version]',
    '',
    'The runtime is normally started by the ReMCP device agent and speaks MCP over stdio.',
    'It executes file, search, terminal, and process tools locally on this computer.',
    '',
    'Usage metrics are opt-out: only tool names, timings and outcomes are collected, and they',
    'travel to your own ReMCP account through the already-authenticated paired agent. Nothing is',
    'sent to a third party, there is no install ping, and there are no remote feature flags.',
    'Disable with `remcp telemetry off`, REMCP_RUNTIME_DISABLE_TELEMETRY=1, or',
    '"telemetryEnabled": false in runtime.json.',
    '',
  ].join('\n'));
  process.exit(0);
}

if (args.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (args.includes('--print-tools')) {
  process.stdout.write(`${JSON.stringify(toolDefinitions.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })), null, 2)}\n`);
  process.exit(0);
}

if (args.includes('--describe')) {
  process.stdout.write(`${JSON.stringify({ version: VERSION, tools: toolDefinitions.length, ...describeConfig() }, null, 2)}\n`);
  process.exit(0);
}

function announceTelemetryOnce() {
  if (!telemetryEnabled()) return;
  const marker = path.join(runtimeConfigDir, '.telemetry-notice');
  try {
    if (existsSync(marker)) return;
    mkdirSync(runtimeConfigDir, { recursive: true, mode: 0o700 });
    writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch { return; }
  console.error('ReMCP runtime: anonymous usage metrics are on (tool names, timings, outcomes only - never file paths, commands or output). They go to your own ReMCP account through the paired agent. Disable with `remcp telemetry off`.');
}

const server = new Server(
  { name: 'remcp-runtime', version: VERSION },
  {
    capabilities: { tools: {}, experimental: { 'remcp/telemetry': { version: 1, optOut: true } } },
    instructions: [
      'This runtime executes file, search, terminal, and process tools locally on a computer that its owner paired with ReMCP.',
      'Inspect before changing: read and list first, then write, edit, move, or run commands only when the user asked for that side effect.',
      'Paths are absolute or resolve against the runtime working directory; prefer absolute paths.',
      'Commands matching the built-in catastrophic-command guardrail are refused before they run.',
    ].join(' '),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  return invokeTool(request.params.name, request.params.arguments);
});

// Telemetry leaves this process only as an MCP notification to the agent that started
// it. The runtime never opens a network connection of its own.
setTelemetrySink(async payload => {
  await server.notification({ method: 'notifications/remcp/telemetry', params: payload });
});

async function shutdown(code = 0) {
  shutdownSessions();
  try { await flush(); } catch {}
  shutdownTelemetry();
  try { await server.close(); } catch {}
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('exit', () => { shutdownSessions(); shutdownTelemetry(); });

const transport = new StdioServerTransport();
await server.connect(transport);
startSessionSweeper();
announceTelemetryOnce();
console.error(`ReMCP runtime ${VERSION} ready with ${toolDefinitions.length} tools`);
