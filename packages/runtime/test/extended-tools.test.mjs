import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allExtendedTools,
  advertisedExtendedTools,
  capabilitySnapshot,
  extendedToolDefinitions,
  extendedToolHandlers,
} from '../src/extended/catalog.mjs';
import { browserNavigate, browserSnapshot, browserTabs } from '../src/extended/browser.mjs';
import { hasTool, invokeTool } from '../src/invoke.mjs';

const EXPECTED = [
  'computer_snapshot','computer_action','list_windows','window_action','launch_app',
  'ui_snapshot','ui_find','ui_action','type_text','keyboard','pointer','drag_drop',
  'scroll','wait_for_ui','clipboard','display_inventory','screenshot_region',
  'open_path','reveal_path','notification',
  'browser_tabs','browser_navigate','browser_snapshot','browser_find','browser_action',
  'browser_wait','browser_evaluate',
  'service','event_log','network','installed_apps','environment','audio','power_action','record_screen',
  'read_document','edit_spreadsheet','edit_document','pdf_action',
];

test('extended computer-use catalog is complete, unique, annotated and invokable', () => {
  assert.equal(extendedToolDefinitions.length, EXPECTED.length);
  assert.deepEqual(extendedToolDefinitions.map(tool => tool.name), EXPECTED);
  assert.equal(new Set(EXPECTED).size, EXPECTED.length);
  assert.equal(extendedToolHandlers.size, EXPECTED.length);
  for (const tool of extendedToolDefinitions) {
    assert.equal(extendedToolHandlers.get(tool.name)?.handler, tool.handler, `${tool.name} handler registration`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} input schema`);
    assert.equal(typeof tool.outputSchema, 'object', `${tool.name} output schema`);
    assert.ok(tool.outputSchema && (tool.outputSchema.type || tool.outputSchema.oneOf), `${tool.name} output schema must constrain structuredContent`);
    assert.ok(tool.description.length > 40, `${tool.name} should have a useful description`);
    for (const key of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint']) {
      assert.equal(typeof tool.annotations?.[key], 'boolean', `${tool.name}.${key}`);
    }
    assert.equal(hasTool(tool.name), true, `${tool.name} must be reachable through invokeTool`);
  }
});

test('extended tool schemas are written for agent selection rather than name guessing', () => {
  const byName = new Map(extendedToolDefinitions.map(tool => [tool.name, tool]));
  const walk = (node, path, missing) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) {
      for (const [name, property] of Object.entries(node.properties)) {
        const current = `${path}.${name}`;
        if (!String(property?.description || '').trim() || String(property.description).startsWith('Parameter ')) missing.push(current);
        walk(property, current, missing);
      }
    }
    if (node.items) walk(node.items, `${path}[]`, missing);
  };
  for (const tool of extendedToolDefinitions) {
    assert.match(tool.description, /^Use this\b/, `${tool.name} has selection-oriented description`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} rejects unknown top-level arguments`);
    assert.ok(String(tool.outputSchema?.description || '').includes(tool.name), `${tool.name} output schema is tool-specific`);
    const missing = [];
    walk(tool.inputSchema, tool.name, missing);
    assert.deepEqual(missing, [], `${tool.name} has meaningful descriptions for every schema property`);
  }
  assert.match(byName.get('type_text').description, /keyboard/i);
  assert.match(byName.get('keyboard').description, /type_text/i);
  assert.match(byName.get('pointer').description, /ui_action.*browser_action|browser_action.*ui_action/i);
  assert.match(byName.get('browser_action').description, /pointer|desktop/i);
  assert.match(byName.get('browser_evaluate').description, /escape hatch/i);
  assert.match(byName.get('read_document').description, /without opening|launching/i);
  for (const name of ['computer_snapshot','browser_tabs','browser_snapshot','browser_find','browser_wait','scroll','display_inventory','installed_apps','environment','read_document']) {
    assert.equal(byName.get(name).annotations.openWorldHint, false, name + ' stays within local/private state');
  }
  for (const name of ['browser_navigate','browser_action','browser_evaluate','computer_action','network']) {
    assert.equal(byName.get(name).annotations.openWorldHint, true, name + ' can reach open-ended external state');
  }
  assert.equal(byName.get('browser_navigate').annotations.destructiveHint, false, 'navigation changes browser state but is not inherently irreversible');
});

test('extended output schemas expose stable chaining fields instead of an untyped object', () => {
  const byName = new Map(extendedToolDefinitions.map(tool => [tool.name, tool]));
  for (const tool of extendedToolDefinitions) {
    const fields = Object.keys(tool.outputSchema?.properties || {}).filter(name => !['truncated','bytes','preview','data','text'].includes(name));
    const natural = ['list_windows','display_inventory','browser_tabs','installed_apps'].includes(tool.name)
      ? Boolean(tool.outputSchema?.properties?.data)
      : fields.length > 0 || Boolean(tool.outputSchema?.properties?.text);
    assert.equal(natural, true, `${tool.name} describes its structured result`);
  }
  const windowItem = byName.get('list_windows').outputSchema.properties.data.items.properties;
  for (const key of ['id','pid','app','title','x','y','width','height']) assert.ok(windowItem[key], `list_windows exposes ${key}`);
  const uiNode = byName.get('ui_snapshot').outputSchema.properties.nodes.items.properties;
  for (const key of ['id','label','role','name']) assert.ok(uiNode[key], `ui_snapshot exposes ${key}`);
  const tab = byName.get('browser_tabs').outputSchema.properties.data.items.properties;
  for (const key of ['id','title','url']) assert.ok(tab[key], `browser_tabs exposes ${key}`);
  const match = byName.get('browser_find').outputSchema.properties.matches.items.properties;
  for (const key of ['selector','role','text']) assert.ok(match[key], `browser_find exposes ${key}`);
});

test('MCP SDK enforces conditional argument requirements before extended handlers run', async () => {
  const { fromJsonSchema } = await import('@modelcontextprotocol/server');
  const byName = new Map(extendedToolDefinitions.map(tool => [tool.name, tool]));
  const cases = [
    ['launch_app', {}, { app:'zenity' }],
    ['keyboard', {}, { key:'TAB' }],
    ['drag_drop', { from_id:'a' }, { from_id:'a', to_id:'b' }],
    ['browser_action', { action:'press' }, { action:'press', key:'Enter' }],
    ['browser_wait', { condition:'text' }, { condition:'text', text:'ready' }],
    ['service', { action:'restart' }, { action:'restart', name:'demo.service' }],
    ['audio', { action:'set_volume' }, { action:'set_volume', volume:50 }],
    ['pdf_action', { action:'merge', paths:['a.pdf','b.pdf'] }, { action:'merge', paths:['a.pdf','b.pdf'], output:'merged.pdf' }],
  ];
  for (const [name, invalid, valid] of cases) {
    const wrapped = fromJsonSchema(byName.get(name).inputSchema);
    const bad = await wrapped['~standard'].validate(invalid);
    const good = await wrapped['~standard'].validate(valid);
    assert.ok(bad.issues?.length, name + ' rejects its incomplete action shape');
    assert.equal(good.issues?.length || 0, 0, name + ' accepts its complete action shape');
  }
});

test('capability-aware live advertising is a subset of the full release contract', async () => {
  const all = allExtendedTools();
  const advertised = await advertisedExtendedTools();
  const capabilities = await capabilitySnapshot();
  assert.equal(all.length, EXPECTED.length);
  assert.ok(advertised.length > 0);
  assert.ok(advertised.length <= all.length);
  assert.equal(typeof capabilities, 'object');
  const allNames = new Set(all.map(tool => tool.name));
  for (const tool of advertised) assert.ok(allNames.has(tool.name));
  for (const always of [
    'computer_snapshot','computer_action','launch_app',
    'network','environment','read_document','pdf_action',
  ]) {
    assert.ok(advertised.some(tool => tool.name === always), `${always} should remain discoverable`);
  }
  for (const browserTool of ['browser_tabs','browser_navigate','browser_snapshot','browser_find','browser_action','browser_wait','browser_evaluate']) {
    assert.equal(advertised.some(tool => tool.name === browserTool), Boolean(capabilities.browser_cdp), `${browserTool} should follow the live CDP capability`);
  }
});

test('browser_navigate new_tab bootstraps CDP when no page target exists', async () => {
  const originalFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, options = {}) => {
    seen = { url:String(url), method:options.method || 'GET' };
    return new Response(JSON.stringify({
      id:'created-page',
      type:'page',
      title:'',
      url:'https://example.test/',
      webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/created-page',
    }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  try {
    const result = await browserNavigate({ endpoint:'http://127.0.0.1:9222', action:'new_tab', url:'https://example.test/' });
    assert.equal(seen.method, 'PUT');
    assert.match(seen.url, /\/json\/new\?/);
    assert.equal(result.structuredContent.action, 'new_tab');
    assert.equal(result.structuredContent.target_id, 'created-page');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('browser CDP rejects non-loopback endpoints before network access', async () => {
  await assert.rejects(() => browserTabs({ endpoint: 'https://example.com:9222' }), /loopback-only/i);
  await assert.rejects(() => browserTabs({ endpoint: 'file:///tmp/socket' }), /http or https/i);
});

test('browser CDP rejects a non-loopback WebSocket target returned by a local endpoint', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'page-1', type: 'page', title: 'Fixture', url: 'https://example.test/',
    webSocketDebuggerUrl: 'ws://example.com/devtools/page/1',
  }]), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => browserSnapshot({ endpoint: 'http://127.0.0.1:9222' }), /WebSocket target must be loopback-only/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JSON-oriented extended tools expose object-root structuredContent alongside text fallback', async () => {
  const result = await invokeTool('environment', {});
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.platform, process.platform);
  assert.equal(typeof result.content?.[0]?.text, 'string');
  assert.equal(JSON.parse(result.content[0].text).platform, process.platform);

  const { jsonResult } = await import('../src/extended/common.mjs');
  const arrayResult = jsonResult([{ id: 1 }]);
  assert.deepEqual(arrayResult.structuredContent, { data: [{ id: 1 }] });
  assert.deepEqual(JSON.parse(arrayResult.content[0].text), [{ id: 1 }]);
});

test('the release contract contains 83 unique tools: 44 existing plus 39 computer-use tools', async () => {
  const { advertisedTools } = await import('../src/catalog.mjs');
  const names = [...advertisedTools(), ...allExtendedTools()].map(tool => tool.name);
  assert.equal(names.length, 83);
  assert.equal(new Set(names).size, 83);
});