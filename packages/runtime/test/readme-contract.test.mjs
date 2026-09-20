import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { advertisedTools } from '../src/catalog.mjs';
import { allExtendedTools } from '../src/extended/catalog.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const coreTools = advertisedTools();
const tools = [...coreTools, ...allExtendedTools()];

test('runtime README describes the tool surface that the package actually advertises', () => {
  assert.equal(coreTools.length, 44, 'the backwards-compatible core tool set remains 44 tools');
  assert.equal(tools.length, 83, 'the 0.2.48 runtime release contract has 83 local tools');
  assert.match(
    readme,
    new RegExp(`\\b${tools.length} tools\\b`, 'i'),
    'README tool count must come from the runtime contract, not an old release',
  );
  assert.doesNotMatch(readme, /\b35 tools\b|\b43 tools\b/i);
});

test('runtime README and introspection metadata explain the limited MCP settings surface', () => {
  const setter = tools.find(tool => tool.name === 'set_config_value');
  const info = tools.find(tool => tool.name === 'get_runtime_info');
  assert.ok(setter, 'set_config_value is part of the advertised runtime');
  assert.match(readme, /set_config_value/i);
  assert.doesNotMatch(readme, /deliberately no `set_config_value`/i);
  assert.match(
    info?.description || '',
    /set_config_value|settable preferences/i,
    'get_runtime_info must not claim that no configuration can be changed through MCP',
  );
});