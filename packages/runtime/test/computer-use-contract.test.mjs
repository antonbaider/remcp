import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extendedToolDefinitions } from '../src/extended/catalog.mjs';
import { computerAction, pointer, scroll, uiAction, uiFind, waitForUi, windowAction } from '../src/extended/desktop.mjs';
import { browserFind } from '../src/extended/browser.mjs';
import * as linux from '../src/extended/desktop-linux.mjs';

const tool = name => {
  const value = extendedToolDefinitions.find(item => item.name === name);
  assert.ok(value, `missing tool definition: ${name}`);
  return value;
};

test('computer_action stays a narrow cross-backend fallback instead of duplicating specialist tools', () => {
  const computerAction = tool('computer_action');
  const actions = computerAction.inputSchema.properties.action.enum;
  for (const action of [
    'click','invoke','focus','set_value','select','toggle',
    'expand','collapse','scroll_into_view','set_range_value',
    'add_to_selection','remove_from_selection','multi_select','multi_edit',
  ]) assert.ok(actions.includes(action), `computer_action missing cross-backend action ${action}`);
  for (const action of [
    'ui','pointer','window','type','keyboard','scroll','drag','clipboard','launch_app',
    'double_click','right_click',
    'open_path','reveal_path','notification','move','down','up','minimize','maximize',
    'restore','move_resize','resize','close','wait','batch',
  ]) assert.equal(actions.includes(action), false, `computer_action must not duplicate specialist action ${action}`);
  for (const property of ['operation','shortcut','key','from_x','from_y','to_x','to_y','delta_x','delta_y','path','message','wait_ms','seconds','steps','args']) {
    assert.equal(Object.hasOwn(computerAction.inputSchema.properties, property), false, `computer_action must not advertise specialist field ${property}`);
  }
  assert.match(computerAction.description, /only when/i);
  assert.match(computerAction.description, /ui_action/i);
  assert.match(computerAction.description, /browser_action/i);
  assert.match(computerAction.description, /type_text/i);
  assert.match(computerAction.description, /window_action/i);

  const uiAction = tool('ui_action');
  const uiActions = uiAction.inputSchema.properties.action.enum;
  for (const action of [
    'invoke','focus','set_value','select','toggle','expand','collapse',
    'scroll_into_view','set_range_value','add_to_selection','remove_from_selection',
  ]) assert.ok(uiActions.includes(action), `ui_action missing ${action}`);

  const snapshotTool = tool('computer_snapshot');
  const snapshot = snapshotTool.inputSchema.properties;
  assert.deepEqual(snapshotTool.outputSchema.properties.active_window.type, ['object','null'], 'active_window may be unknown even when native accessibility is available');
  assert.deepEqual(snapshot.ui_scope.enum, ['active','desktop']);
  assert.equal(snapshot.screenshot_region.minItems, 4);
  assert.equal(snapshot.screenshot_region.maxItems, 4);
  assert.equal(snapshot.ui_browser_dom.type, 'boolean');

  const launch = tool('launch_app').inputSchema.properties;
  assert.equal(launch.cwd.type, 'string');
  assert.equal(launch.wait_for_window.type, 'string');

  const find = tool('ui_find').inputSchema.properties;
  assert.equal(find.label.type, 'number');
  assert.equal(find.refresh.type, 'boolean');
});

test('desktop action schemas reject targetless or no-op calls before execution', async () => {
  const uiSchema = tool('ui_action').inputSchema;
  assert.ok(Array.isArray(uiSchema.allOf) && uiSchema.allOf.length >= 2, 'ui_action declares target/value conditions');

  const windowSchema = tool('window_action').inputSchema;
  assert.ok(Array.isArray(windowSchema.allOf) && windowSchema.allOf.length >= 4, 'window_action declares target and geometry conditions');

  const pointerSchema = tool('pointer').inputSchema;
  assert.ok(Array.isArray(pointerSchema.allOf) && pointerSchema.allOf.length >= 1, 'pointer move declares coordinate requirements');

  const scrollSchema = tool('scroll').inputSchema;
  assert.ok(Array.isArray(scrollSchema.anyOf) && scrollSchema.anyOf.length >= 4, 'scroll requires direction or delta');

  const computerSchema = tool('computer_action').inputSchema;
  assert.ok(Array.isArray(computerSchema.allOf) && computerSchema.allOf.length >= 6, 'computer_action declares action-specific target requirements');

  assert.ok(Array.isArray(tool('ui_find').inputSchema.anyOf), 'ui_find declares an element selector requirement');
  assert.ok(Array.isArray(tool('browser_find').inputSchema.anyOf), 'browser_find declares a page-element selector requirement');
  assert.ok(Array.isArray(tool('wait_for_ui').inputSchema.anyOf), 'wait_for_ui requires an explicit state or condition');

  await assert.rejects(() => uiFind({}), /use ui_snapshot to enumerate UI/);
  await assert.rejects(() => browserFind({}), /use browser_snapshot to enumerate page structure/);
  await assert.rejects(() => waitForUi({}), /requires state or condition/);
  await assert.rejects(() => waitForUi({ state:'present' }), /requires a semantic target/);
  await assert.rejects(() => waitForUi({ condition:'active_window' }), /requires text, name, or window_title/);
  await assert.rejects(() => uiAction({ action:'click' }), /requires id, label, name, role, or automation_id/);
  await assert.rejects(() => uiAction({ action:'set_value', name:'Search' }), /requires value/);
  await assert.rejects(() => windowAction({ action:'focus' }), /requires id, pid, app, or title/);
  await assert.rejects(() => windowAction({ action:'move', id:'window-1' }), /requires x and y/);
  await assert.rejects(() => pointer({ action:'move' }), /requires x and y/);
  await assert.rejects(() => scroll({}), /requires direction or a delta/);
});

test('computer_action wait is bounded and batch executes sequential grouped actions', async () => {
  const started = Date.now();
  const waited = await computerAction({ action:'wait', wait_ms:25 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 15, `wait returned too early: ${elapsed}ms`);
  const payload = waited.structuredContent;
  assert.equal(payload.action, 'wait');
  assert.equal(payload.waited_ms, 25);
  assert.equal(payload.capped, false);

  const batch = await computerAction({
    action:'batch',
    steps:[
      { action:'wait', wait_ms:5 },
      { action:'wait', wait_ms:5 },
    ],
  });
  assert.equal(batch.structuredContent.action, 'batch');
  assert.equal(batch.structuredContent.ok, true);
  assert.equal(batch.structuredContent.completed, 2);
  assert.deepEqual(batch.structuredContent.results.map(row => row.index), [0,1]);

  await assert.rejects(() => computerAction({ action:'wait' }), /requires wait_ms or seconds/);
}, { timeout: 2_000 });

test('Linux XWayland pixel geometry uses xwininfo absolute client coordinates', () => {
  const sample = `
  Absolute upper-left X:  421
  Absolute upper-left Y:  280
  Relative upper-left X:  14
  Relative upper-left Y:  49
  Width: 600
  Height: 240
`;
  assert.deepEqual(linux.parseX11PixelBounds(sample), { x:421, y:280, width:600, height:240 });
  assert.equal(linux.parseX11PixelBounds('Width: 0\nHeight: 0'), null);
});

test('Linux semantic typing rejects false AT-SPI writes and auto typing fails safely', async () => {
  const linuxSource = await readFile(new URL('../src/extended/desktop-linux.mjs', import.meta.url), 'utf8');
  const desktopSource = await readFile(new URL('../src/extended/desktop.mjs', import.meta.url), 'utf8');

  assert.match(
    linuxSource,
    /setTextContents\(value\)[\s\S]{0,180}is False[\s\S]{0,180}raise Exception/,
    'Linux set_value must treat an explicit AT-SPI false result as a failed semantic write',
  );
  assert.match(
    desktopSource,
    /method === 'auto'[\s\S]{0,600}try \{[\s\S]{0,500}uiAction\([\s\S]{0,900}catch[\s\S]{0,300}method === 'accessibility'[\s\S]{0,120}throw/,
    'type_text auto mode must inspect semantic set_value failure while accessibility-only mode stays fail-closed',
  );
  assert.match(
    desktopSource,
    /Semantic text target rejected accessibility input[\s\S]{0,160}browser_action/,
    'auto typing must fail safely instead of claiming an unverified keyboard paste into a semantic browser target',
  );
  assert.match(
    desktopSource,
    /if \(method === 'accessibility'\)[\s\S]{0,180}Accessibility-only text input requires a semantic element target/,
    'explicit accessibility-only typing must never silently fall through to clipboard or key injection',
  );
  assert.match(
    linuxSource,
    /grabFocus\(\) is False[\s\S]{0,120}raise Exception/,
    'Linux semantic focus must reject an explicit false AT-SPI focus result',
  );
  assert.doesNotMatch(
    linuxSource,
    /backend !== 'portal' && await runXdotool\(\)\) return jsonResult\(\{ from:\[args\.from_x,args\.from_y\], to:\[args\.to_x,args\.to_y\], backend:'xwayland-xdotool'/,
    'GNOME Wayland drag must not claim success through unreliable XTEST/xdotool fallback',
  );
  assert.match(
    linuxSource,
    /Wayland drag and drop[\s\S]{0,240}XTEST\/xdotool drag events are not reliably delivered through GNOME Wayland/,
    'Wayland drag failures should direct the caller to the portal backend',
  );
});

test('Linux direct app launch honors cwd rather than silently accepting it', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'remcp-launch-cwd-'));
  try {
    const marker = 'cwd-marker';
    await linux.launchApp('/usr/bin/touch', [marker], { cwd:dir });
    const target = path.join(dir, marker);
    const deadline = Date.now() + 3000;
    let found = false;
    while (Date.now() < deadline) {
      try { await stat(target); found = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(found, true, 'detached child did not create marker in requested cwd');
  } finally {
    await rm(dir, { recursive:true, force:true });
  }
});

test('Windows adapter source keeps the rich UIA/MSAA path compatible with Windows PowerShell 5.1', async () => {
  const windowsSource = await readFile(new URL('../src/extended/desktop-windows.mjs', import.meta.url), 'utf8');
  const commonSource = await readFile(new URL('../src/extended/common.mjs', import.meta.url), 'utf8');

  for (const marker of [
    'CacheRequest',
    'RootWebArea',
    'AccessibleObjectFromWindow',
    'LegacyIAccessiblePattern',
    'AttachThreadInput',
    'GetDpiForMonitor',
    'Get-StartApps',
    "Filter '*.lnk'",
    '-WorkingDirectory',
    'ScrollItemPattern',
    'RangeValuePattern',
    'SelectionItemPattern',
    'ExpandCollapsePattern',
  ]) assert.ok(windowsSource.includes(marker), `Windows adapter missing ${marker}`);

  assert.ok(commonSource.includes("WindowsPowerShell', 'v1.0', 'powershell.exe'"), 'runtime must keep the Windows PowerShell 5.1 execution path');
  assert.equal(/\$[A-Za-z_][\w.]*\s*\?\?/.test(windowsSource), false, 'embedded PowerShell must not contain PS7-only null-coalescing syntax');
  assert.equal(windowsSource.includes('FindAllBuildCache'), false, 'managed .NET UIA must use activated CacheRequest + FindAll, not native-only FindAllBuildCache');
});
