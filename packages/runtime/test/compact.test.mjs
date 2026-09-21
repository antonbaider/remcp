import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { body, freshWorkspace } from './helpers.mjs';
import { compactRuntimeGroups, compactRuntimeToolDefinitions } from '../src/compact-catalog.mjs';

const entry = fileURLToPath(new URL('../src/compact.mjs', import.meta.url));
const root = freshWorkspace('compact-runtime');

test('compact catalog is small, verb_noun, and contains no granular convenience siblings', async () => {
  const tools = await compactRuntimeToolDefinitions();
  assert.ok(tools.length >= 3 && tools.length <= 8, `compact host should advertise 3-8 tools, saw ${tools.length}`);
  const names = tools.map(tool => tool.name);
  assert.equal(names[0], 'read_file');
  for (const name of names) assert.match(name, /^[a-z]+_[a-z0-9_]+$/, `${name} follows verb_noun snake_case`);
  for (const legacy of ['write_file','copy_file','delete_path','start_process','computer_snapshot','network','environment','pdf_action']) {
    assert.equal(names.includes(legacy), false, `${legacy} remains an operation rather than a top-level compact tool`);
  }
  for (const group of names.filter(name => name !== 'read_file')) {
    assert.ok(compactRuntimeGroups[group]?.length, `${group} maps to real runtime operations`);
    const definition = tools.find(tool => tool.name === group);
    assert.ok(definition.inputSchema.properties.operation.enum.length >= 1);
  }
});

test('compact stdio facade executes real file and terminal runtime handlers', async () => {
  const transport = new StdioClientTransport({ command:process.execPath, args:[entry], env:{ ...process.env } });
  const client = new Client({ name:'remcp-compact-test', version:'1.0.0' }, { versionNegotiation:{ mode:'legacy' } });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    assert.ok(names.includes('manage_files'));
    assert.ok(names.includes('run_terminal'));
    assert.equal(names.includes('write_file'), false);

    const target = path.join(root, 'compact.txt');
    const written = await client.callTool({
      name:'manage_files',
      arguments:{ operation:'write_file', parameters:{ path:target, content:'compact facade\n' } },
    });
    assert.equal(written.isError, undefined);
    assert.equal(readFileSync(target, 'utf8'), 'compact facade\n');

    const read = await client.callTool({ name:'read_file', arguments:{ path:target } });
    assert.match(body(read), /compact facade/);

    const terminal = await client.callTool({
      name:'run_terminal',
      arguments:{ operation:'start_process', parameters:{ command:'printf "compact-terminal\\n"', timeout_ms:2000 } },
    });
    assert.equal(terminal.isError, undefined);
    assert.match(body(terminal), /compact-terminal/);
  } finally {
    await client.close();
  }
});
