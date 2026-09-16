import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { body, freshWorkspace } from './helpers.mjs';

const run = promisify(execFile);
const root = freshWorkspace('stdio');
const entry = path.resolve('src/index.mjs');

function printedTools() {
  return JSON.parse(execFileSync(process.execPath, [entry, '--print-tools'], { encoding: 'utf8' }));
}

test('runtime serves MCP over stdio like the ReMCP agent expects', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
  const client = new Client({ name: 'remcp-agent-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, printedTools().length);
    const target = join(root, 'stdio.txt');
    const written = await client.callTool({ name: 'write_file', arguments: { path: target, content: 'over stdio\n' } });
    assert.equal(written.isError, undefined);
    assert.equal(readFileSync(target, 'utf8'), 'over stdio\n');
    const read = await client.callTool({ name: 'read_file', arguments: { path: target } });
    assert.match(body(read), /over stdio/);
    const process1 = await client.callTool({ name: 'start_process', arguments: { command: 'printf "stdio-process\\n"', timeout_ms: 2000 } });
    assert.match(body(process1), /stdio-process/);
  } finally {
    await client.close();
  }
});

test('--print-tools and --describe expose contract metadata', async () => {
  const { stdout: toolsOut } = await run(process.execPath, [entry, '--print-tools']);
  const tools = JSON.parse(toolsOut);
  assert.ok(tools.length >= 23, `expected the expanded tool surface, saw ${tools.length}`);
  for (const tool of tools) assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  const { stdout: describeOut } = await run(process.execPath, [entry, '--describe']);
  const described = JSON.parse(describeOut);
  assert.equal(described.tools, tools.length);
  assert.equal(described.allowedRoots.length, 0);
  assert.equal(described.configFile.endsWith('runtime.json'), true);
  assert.equal(described.telemetryEnabled, true, 'usage metrics are opt-out, so they start on');
  assert.equal(described.telemetryTransport, 'paired-agent-only');
  assert.equal(described.dangerousCommands, 'allow', 'the destructive-command guardrail is opt-in');
});

test('contract metadata works from a bare package with no node_modules', async () => {
  // CI diffs the advertised contract against the published tarball, which has no
  // dependencies installed. If the entry point imported the MCP SDK eagerly, that check
  // would silently stop being able to run.
  const bare = mkdtempSync(join(tmpdir(), 'remcp-runtime-bare-'));
  cpSync(path.resolve('src'), join(bare, 'src'), { recursive: true });
  cpSync('package.json', join(bare, 'package.json'));
  try {
    const { stdout } = await run(process.execPath, [join(bare, 'src/index.mjs'), '--print-tools']);
    const tools = JSON.parse(stdout);
    assert.ok(tools.length >= 23);
    const { stdout: described } = await run(process.execPath, [join(bare, 'src/index.mjs'), '--describe']);
    assert.equal(JSON.parse(described).tools, tools.length);
    const { stdout: version } = await run(process.execPath, [join(bare, 'src/index.mjs'), '--version']);
    assert.match(version.trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
