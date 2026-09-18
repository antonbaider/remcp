import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capturePortalScreenshot, isWaylandSession } from '../src/screenshot-portal.mjs';

class FakeVariant {
  constructor(signature, value) {
    this.signature = signature;
    this.value = value;
  }
}

class FakeMessage {
  constructor(value) { Object.assign(this, value); }
}

function fakeDbus({ response = 0, uri, returnedHandle } = {}) {
  const bus = new EventEmitter();
  bus.name = ':1.42';
  let addMatchSeen = false;
  let disconnected = false;
  const signalType = 4;
  bus.call = async message => {
    if (message.member === 'AddMatch') addMatchSeen = true;
    if (message.member === 'RemoveMatch') addMatchSeen = false;
    return null;
  };
  bus.disconnect = () => { disconnected = true; };
  bus.getProxyObject = async (_name, objectPath) => {
    assert.equal(objectPath, '/org/freedesktop/portal/desktop');
    return {
      getInterface(name) {
        assert.equal(name, 'org.freedesktop.portal.Screenshot');
        return {
          async Screenshot(_parent, options) {
            assert.equal(addMatchSeen, true, 'Response match must be installed before Screenshot()');
            assert.equal(options.interactive.value, false);
            assert.match(options.handle_token.value, /^remcp_/);
            const predicted = `/org/freedesktop/portal/desktop/request/1_42/${options.handle_token.value}`;
            const handle = returnedHandle?.(options.handle_token.value) || predicted;
            // Emit synchronously, before the method reply. This is the race the implementation must
            // handle: a listener installed after Screenshot() returns would miss this response.
            bus.emit('message', {
              type: signalType,
              path: handle,
              interface: 'org.freedesktop.portal.Request',
              member: 'Response',
              body: [response, uri ? { uri: new FakeVariant('s', uri) } : {}],
            });
            return handle;
          },
        };
      },
    };
  };
  return {
    module: {
      Variant: FakeVariant,
      Message: FakeMessage,
      MessageType: { SIGNAL: signalType },
      sessionBus: () => bus,
    },
    disconnected: () => disconnected,
  };
}

test('Wayland detection accepts session type or WAYLAND_DISPLAY', () => {
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }), true);
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), false);
});

test('portal screenshot subscribes before the method call and cleans its intermediate file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-portal-test-'));
  const source = join(root, 'source.png');
  const destination = join(root, 'destination.png');
  writeFileSync(source, Buffer.from('fake-png'));
  const fake = fakeDbus({ uri: pathToFileURL(source).href });

  const returned = await capturePortalScreenshot(destination, { loadDbus: async () => fake.module, timeoutMs: 1000 });
  assert.equal(returned, destination);
  assert.equal(readFileSync(destination, 'utf8'), 'fake-png');
  assert.equal(existsSync(source), false, 'portal-created intermediate should be removed after copying');
  assert.equal(fake.disconnected(), true);
});

test('portal screenshot buffers a fast response when an older portal returns a different handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-portal-legacy-'));
  const source = join(root, 'source.png');
  const destination = join(root, 'destination.png');
  writeFileSync(source, Buffer.from('legacy-png'));
  const fake = fakeDbus({
    uri: pathToFileURL(source).href,
    returnedHandle: token => `/org/freedesktop/portal/desktop/request/legacy_sender/${token}`,
  });

  await capturePortalScreenshot(destination, { loadDbus: async () => fake.module, timeoutMs: 1000 });
  assert.equal(readFileSync(destination, 'utf8'), 'legacy-png');
  assert.equal(fake.disconnected(), true);
});

test('portal screenshot preserves cancellation and rejects non-file responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remcp-portal-errors-'));
  const destination = join(root, 'destination.png');
  const cancelled = fakeDbus({ response: 1 });
  await assert.rejects(
    capturePortalScreenshot(destination, { loadDbus: async () => cancelled.module, timeoutMs: 1000 }),
    error => error.code === 'PORTAL_CANCELLED' && /screen capture permission was cancelled/.test(error.message),
  );
  assert.equal(cancelled.disconnected(), true);

  const remote = fakeDbus({ uri: 'https://example.test/screenshot.png' });
  await assert.rejects(
    capturePortalScreenshot(destination, { loadDbus: async () => remote.module, timeoutMs: 1000 }),
    /unsupported URI scheme https:/,
  );
  assert.equal(remote.disconnected(), true);
});
