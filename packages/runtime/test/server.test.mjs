import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { body, freshWorkspace } from './helpers.mjs';

const root = freshWorkspace('server');
writeFileSync(join(root, 'sample.txt'), 'sample line\n');
const { toolDefinitions } = await import('../src/catalog.mjs');
const { hasTool, invokeTool } = await import('../src/invoke.mjs');

function buildServer() {
  const server = new Server({ name: 'remcp-runtime', version: 'test' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => invokeTool(request.params.name, request.params.arguments));
  return server;
}

test('runtime advertises a fully annotated tool surface', async () => {
  const server = buildServer();
  const client = new Client({ name: 'runtime-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, toolDefinitions.length);
    const names = tools.map(tool => tool.name);
    assert.equal(new Set(names).size, names.length);
    for (const required of ['read_file', 'write_file', 'edit_block', 'copy_file', 'start_process', 'wait_for_process_output', 'get_runtime_info', 'get_runtime_stats']) {
      assert.ok(names.includes(required), `tool surface is missing ${required}`);
    }
    for (const tool of tools) {
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof tool.annotations?.[key], 'boolean', `${tool.name}.${key}`);
      }
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      assert.doesNotMatch(tool.description, /execute_command|analysis tool|Desktop Commander/i, `${tool.name} leaks upstream wording`);
    }
    const screenshot = tools.find(tool => tool.name === 'take_screenshot');
    assert.equal(screenshot.annotations.readOnlyHint, false, 'take_screenshot may persist a PNG');
    assert.equal(screenshot.annotations.destructiveHint, false, 'persisting a screenshot is additive rather than destructive');
    assert.equal(screenshot.annotations.idempotentHint, false, 'repeating a kept/oversized screenshot may create another timestamped file');

    // The one configuration tool, and it is narrow by construction: a model may change a preference
    // and the context limits, never the settings that decide what this computer exposes.
    const setter = tools.find(tool => tool.name === 'set_config_value');
    assert.ok(setter, 'a runtime preference can be changed');
    assert.match(setter.inputSchema.properties.key.description, /telemetryEnabled/);
    assert.doesNotMatch(JSON.stringify(setter), /allowedRoots|blockedCommands|defaultShell|maxWriteBytes/);
    assert.equal(hasTool('write_pdf'), false, 'heavy document tooling stays out of the device runtime');
  } finally {
    await client.close();
    await server.close();
  }
});

test('runtime executes tools through MCP and reports unknown tools as errors', async () => {
  const server = buildServer();
  const client = new Client({ name: 'runtime-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const read = await client.callTool({ name: 'read_file', arguments: { path: join(root, 'sample.txt') } });
    assert.match(body(read), /sample line/);
    const unknown = await client.callTool({ name: 'delete_everything', arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(hasTool('delete_everything'), false);
  } finally {
    await client.close();
    await server.close();
  }
});
