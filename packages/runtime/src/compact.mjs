#!/usr/bin/env node
import process from 'node:process';
import { configurationError } from './config.mjs';
import { compactRuntimeToolDefinitions } from './compact-catalog.mjs';
import { shutdownSessions, startSessionSweeper } from './sessions.mjs';
import { VERSION } from './version.mjs';

const args = process.argv.slice(2);

async function writeStdout(value) {
  await new Promise((resolve, reject) => process.stdout.write(value, error => error ? reject(error) : resolve()));
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write([
    'ReMCP compact local runtime',
    '',
    'Usage: remcp-runtime-compact [--print-tools] [--describe] [--version]',
    '',
    'This stdio MCP server exposes the same local ReMCP runtime through a compact verb_noun facade.',
    'It is intended for directory scanners, local MCP clients, and environments where a small tool surface improves selection.',
    '',
  ].join('\n'));
  process.exit(0);
}

if (args.includes('--version')) { process.stdout.write(`${VERSION}\n`); process.exit(0); }

const tools = await compactRuntimeToolDefinitions();
if (args.includes('--print-tools')) { await writeStdout(`${JSON.stringify(tools, null, 2)}\n`); process.exit(0); }
if (args.includes('--describe')) {
  await writeStdout(`${JSON.stringify({ version:VERSION, tools:tools.length, toolNames:tools.map(tool => tool.name) }, null, 2)}\n`);
  process.exit(0);
}

const configProblem = configurationError();
if (configProblem) { console.error(`ReMCP compact runtime refuses to start: ${configProblem}`); process.exit(2); }

const instructions = [
  'This compact runtime executes real ReMCP operations locally on this computer.',
  'Choose one domain tool, then one operation. Inspect before changing state and use the least invasive operation that satisfies the request.',
  'The parameters object is validated against the selected operation’s original closed schema.',
].join(' ');

const { startCompactRuntimeMcpServer } = await import('./compact-mcp.mjs');
const runtimeServer = await startCompactRuntimeMcpServer({
  version:VERSION,
  instructions,
  onError(error) { console.error(`ReMCP compact runtime MCP error: ${error instanceof Error ? error.message : String(error)}`); },
});

let shutdownStarted = false;
async function shutdown(code = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shutdownSessions();
  try { await runtimeServer.close(); } catch {}
  process.exit(code);
}
process.stdout.on('error', error => {
  if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') void shutdown(0);
  else console.error(`ReMCP compact runtime stdout error: ${error instanceof Error ? error.message : String(error)}`);
});
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('exit', () => { shutdownSessions(); });
startSessionSweeper();
console.error(`ReMCP compact runtime ${VERSION} ready with ${tools.length} domain tools`);
