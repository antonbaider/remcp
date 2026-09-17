import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmCandidates, resolveNpm } from '../src/npm.mjs';

test('npm is resolved from the running node, not from PATH', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-npm-'));
  try {
    // A layout like the official installer / nvm / the Docker image: <prefix>/bin/node with
    // <prefix>/lib/node_modules/npm/bin/npm-cli.js.
    const prefix = path.join(root, 'node-v22');
    const bin = path.join(prefix, 'bin');
    mkdirSync(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    const nodePath = path.join(bin, 'node');
    writeFileSync(nodePath, '');
    const cli = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    writeFileSync(cli, '');

    const resolved = resolveNpm({ nodePath, home: root, platform: 'darwin' });
    assert.equal(resolved.command, nodePath, 'npm is executed by the same node that runs the agent');
    assert.deepEqual(resolved.args, [cli]);

    // A machine with no npm at all still returns something runnable and says so.
    const bare = resolveNpm({ nodePath: path.join(root, 'nothing', 'bin', 'node'), home: path.join(root, 'empty'), platform: 'linux' });
    assert.ok(bare.source.includes('PATH'), `reported source: ${bare.source}`);
    assert.ok(npmCandidates({ nodePath, home: root, platform: 'darwin' }).cli.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a background service without a PATH still finds npm on this machine', async () => {
  // The regression that stopped auto-update on macOS: the agent ran with a minimal environment.
  const { npmVersion, resolveNpm: resolve } = await import('../src/npm.mjs');
  const resolved = resolve();
  const info = npmVersion(resolved);
  assert.ok(info, `npm resolved (${resolved.source})`);
  assert.match(info.version, /^\d+\.\d+\.\d+/);
});
