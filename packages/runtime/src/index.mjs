#!/usr/bin/env node
import process from 'node:process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toolDefinitions } from './catalog.mjs';
import { describeConfig, configurationError, runtimeConfigDir } from './config.mjs';
import { invokeTool } from './invoke.mjs';
import { shutdownSessions, startSessionSweeper } from './sessions.mjs';
import { flush, setTelemetrySink, shutdownTelemetry, telemetryEnabled } from './telemetry.mjs';
import { VERSION } from './version.mjs';

// The MCP SDK is imported lazily so that `--help`, `--version`, `--print-tools` and
// `--describe` work from a bare checkout or a published tarball with no node_modules.
// That is what lets CI diff the advertised tool contract against the package users get.

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

// A configuration file the user cannot read must not be ignored: that is how allowedRoots
// and an opt-out quietly disappear. Metadata commands above still work, so an operator can
// inspect the device; the server itself refuses to start.
const configProblem = configurationError();
if (configProblem) {
  console.error(`ReMCP runtime refuses to start: ${configProblem}`);
  process.exit(2);
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

const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

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

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  return invokeTool(request.params.name, request.params.arguments, extra);
});

// Telemetry leaves this process only as an MCP notification to the agent that started
// it. The runtime never opens a network connection of its own.
setTelemetrySink(async payload => {
  await server.notification({ method: 'notifications/remcp/telemetry', params: payload });
});

const SHUTDOWN_BUDGET_MS = 1500;
let shutdownStarted = false;

async function shutdown(code = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const deadline = Date.now() + SHUTDOWN_BUDGET_MS;
  shutdownSessions();
  // The SDK gives a closing server about two seconds before it kills the process, so the
  // telemetry flush is bounded and awaited instead of fire-and-forget: an unawaited
  // notification() after close is an unhandled rejection.
  try {
    await Promise.race([flush(), new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
  } catch {}
  await shutdownTelemetry();
  try { await server.close(); } catch {}
  process.exit(code);
}

// A dead agent leaves a broken stdout pipe. Without this the process died on an
// uncaught EPIPE with a stack trace and left its terminal children behind.
process.stdout.on('error', error => {
  if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') void shutdown(0);
  else console.error(`ReMCP runtime stdout error: ${error instanceof Error ? error.message : String(error)}`);
});
process.on('uncaughtException', error => {
  console.error(`ReMCP runtime uncaught exception: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  void shutdown(1);
});
process.on('unhandledRejection', reason => {
  console.error(`ReMCP runtime unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('exit', () => { shutdownSessions(); });

const transport = new StdioServerTransport();
await server.connect(transport);
startSessionSweeper();
announceTelemetryOnce();
console.error(`ReMCP runtime ${VERSION} ready with ${toolDefinitions.length} tools`);
