import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuntime } from '../src/runtime.mjs';
import { PACKAGE_NAME, VERSION } from '../src/version.mjs';

test('package metadata is stable', () => {
  assert.equal(PACKAGE_NAME, '@remcp/remcp');
  assert.equal(VERSION, '0.1.4');
});

test('runtime manifest accepts a scoped npm package', () => {
  assert.deepEqual(normalizeRuntime({
    kind: 'npm',
    packageName: '@example/local-runtime',
    packageSpec: '@example/local-runtime@1.2.3',
    entry: 'dist/index.js',
  }), {
    kind: 'npm',
    packageName: '@example/local-runtime',
    packageSpec: '@example/local-runtime@1.2.3',
    entry: 'dist/index.js',
  });
});

test('runtime manifest rejects traversal and mismatched specs', () => {
  assert.throws(() => normalizeRuntime({ kind: 'npm', packageName: 'safe-runtime', packageSpec: 'other@1.0.0', entry: 'index.js' }));
  assert.throws(() => normalizeRuntime({ kind: 'npm', packageName: 'safe-runtime', packageSpec: 'safe-runtime@1.0.0', entry: '../index.js' }));
});
