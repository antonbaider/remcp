import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { VERSION } from '../src/version.mjs';

const bin = path.resolve('bin/remcp.mjs');

function fakeExecutable(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

test('install uses a stable global CLI path and update refreshes/restarts it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-cli-'));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const prefix = path.join(root, 'global');
  const configDir = path.join(root, 'config');
  const log = path.join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ serverUrl: 'https://example.invalid', deviceId: 'test', deviceToken: 'test', deviceName: 'test', runtime: { kind: 'npm', packageName: '@example/local-runtime', packageSpec: '@example/local-runtime@1.2.3', entry: 'dist/index.js' } }));
  fakeExecutable(path.join(fakeBin, 'npm'), 'echo "npm $@" >> "$REMCP_TEST_LOG"\nif [ "$1" = "prefix" ]; then echo "$REMCP_TEST_PREFIX"; fi');
  fakeExecutable(path.join(fakeBin, 'systemctl'), 'echo "systemctl $@" >> "$REMCP_TEST_LOG"');
  const env = { ...process.env, HOME: home, REMCP_CONFIG_DIR: configDir, REMCP_TEST_LOG: log, REMCP_TEST_PREFIX: prefix, PATH: `${fakeBin}:${process.env.PATH}`, REMCP_NPM: path.join(fakeBin, 'npm') };

  const install = spawnSync(process.execPath, [bin, 'install'], { env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const unit = readFileSync(path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service'), 'utf8');
  assert.match(unit, new RegExp(`ExecStart="${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp" start`));
  let calls = readFileSync(log, 'utf8');
  assert.match(calls, new RegExp(`npm install --global @remcp/remcp@${VERSION.replaceAll('.', '\\.')}`));
  assert.match(calls, /@example\/local-runtime@1\.2\.3/);
  assert.match(calls, /systemctl --user enable --now remcp-agent\.service/);

  // Reproduce a real upgrade from one Node manager to another: the service still points at a CLI in
  // an old nvm prefix while npm now installs to the current global prefix. Update must repair the unit
  // before it restarts it, otherwise the old agent reconnects and starts the same update again.
  const serviceFile = path.join(home, '.config', 'systemd', 'user', 'remcp-agent.service');
  writeFileSync(serviceFile, readFileSync(serviceFile, 'utf8').replace(`${prefix}/bin/remcp`, '/old/nvm/bin/remcp'));

  const update = spawnSync(process.execPath, [bin, 'update'], { env, encoding: 'utf8' });
  assert.equal(update.status, 0, update.stderr || update.stdout);
  const repairedUnit = readFileSync(serviceFile, 'utf8');
  assert.match(repairedUnit, new RegExp(`ExecStart=\"${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/remcp\" start`));
  assert.doesNotMatch(repairedUnit, /old\/nvm/);
  calls = readFileSync(log, 'utf8');
  assert.match(calls, /npm install --global @remcp\/remcp@latest/);
  assert.match(calls, /systemctl --user daemon-reload/);
  assert.match(calls, /systemctl --user restart remcp-agent\.service/);
});
