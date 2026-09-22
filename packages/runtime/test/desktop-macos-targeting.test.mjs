import test from 'node:test';
import assert from 'node:assert/strict';

import {
  macWindowId,
  normalizeMacWindowTarget,
  windowAction,
} from '../src/extended/desktop-macos.mjs';

test('macOS window ids encode a process-local window index', () => {
  assert.equal(macWindowId(123, 0, 1), 'mac:123:w0:g1');
  assert.equal(macWindowId('456', '7', '9'), 'mac:456:w7:g9');
  assert.throws(() => macWindowId(0, 0, 1), /invalid PID\/index/);
  assert.throws(() => macWindowId(123, -1, 1), /invalid PID\/index/);
});

test('macOS window_action resolves exact new-format ids and rejects stale legacy ids', () => {
  const target = normalizeMacWindowTarget({ id:'mac:123:w2:g4' }, { useWindowId:true });
  assert.equal(target.id, 'mac:123:w2:g4');
  assert.equal(target.idCached, false);
  assert.equal(target.pid, 123);
  assert.equal(target.windowIndex, 2);
  assert.equal(target.app, '');
  assert.equal(target.title, '');
  assert.throws(
    () => normalizeMacWindowTarget({ id:'mac:123:2' }, { useWindowId:true }),
    /stale or unsupported; call list_windows again/,
  );
});

test('macOS window ids cannot silently disagree with an explicit pid', () => {
  assert.throws(
    () => normalizeMacWindowTarget({ id:'mac:123:w1:g4', pid:456 }, { useWindowId:true }),
    /refer to different processes/,
  );
  const target = normalizeMacWindowTarget({ id:'mac:123:w1:g4', pid:123, app:'Fixture', title:'Smoke' }, { useWindowId:true });
  assert.equal(target.pid, 123);
  assert.equal(target.windowIndex, 1);
  assert.equal(target.app, 'Fixture');
  assert.equal(target.title, 'Smoke');
});

test('native UI element ids remain independent from top-level window ids', () => {
  const target = normalizeMacWindowTarget({ id:'mac:123:r.1', pid:123 }, { useWindowId:false });
  assert.equal(target.id, '');
  assert.equal(target.pid, 123);
  assert.equal(target.windowIndex, null);
  assert.equal(target.app, '');
  assert.equal(target.title, '');
});

test('window_action refuses an id that was not obtained from the live list_windows cache', async () => {
  await assert.rejects(
    () => windowAction({ action:'focus', id:'mac:987654:w0:g99' }),
    /stale or unknown; call list_windows again/,
  );
});
