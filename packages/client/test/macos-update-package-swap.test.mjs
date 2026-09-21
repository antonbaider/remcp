import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const serviceUrl = pathToFileURL(path.resolve('src/cli/service.mjs')).href;

function executable(file, body) {
  writeFileSync(file, '#!/bin/sh\n' + body + '\n');
  chmodSync(file, 0o755);
}

function packageDir(prefix, name) {
  return path.join(prefix, 'lib', 'node_modules', ...name.split('/'));
}

function seedOldInstall(prefix) {
  const client = packageDir(prefix, '@remcp/remcp');
  const runtime = packageDir(prefix, '@remcp/runtime');
  mkdirSync(path.join(client, 'bin'), { recursive:true });
  mkdirSync(path.join(runtime, 'src'), { recursive:true });
  mkdirSync(path.join(prefix, 'bin'), { recursive:true });
  writeFileSync(path.join(client, 'package.json'), JSON.stringify({ name:'@remcp/remcp', version:'0.2.50' }));
  writeFileSync(path.join(client, 'bin', 'remcp.mjs'), 'old-client\n');
  writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name:'@remcp/runtime', version:'0.2.50' }));
  writeFileSync(path.join(runtime, 'src', 'index.mjs'), 'old-runtime\n');
  symlinkSync('../lib/node_modules/@remcp/remcp/bin/remcp.mjs', path.join(prefix, 'bin', 'remcp'));
}

function runUpdateHelper(root, npmBody) {
  const prefix = path.join(root, 'prefix');
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive:true });
  seedOldInstall(prefix);
  executable(path.join(bin, 'npm'), npmBody);
  const env = {
    ...process.env,
    NODE_ENV:'test',
    REMCP_TEST_PLATFORM:'darwin',
    REMCP_TEST_PREFIX:prefix,
    REMCP_NPM:path.join(bin, 'npm'),
    PATH:bin + ':' + process.env.PATH,
  };
  const code = 'import { npmGlobalUpdate } from ' + JSON.stringify(serviceUrl) + ';\n'
    + "npmGlobalUpdate(['@remcp/remcp','@remcp/runtime'], '@remcp/remcp@0.2.54', '@remcp/runtime@0.2.54');\n";
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding:'utf8' });
  return { prefix, result };
}

test('macOS global update moves the live ReMCP package trees aside before npm mutates them', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-mac-update-swap-'));
  const npmBody = [
    'if [ "$1" = "prefix" ] && [ "$2" = "--global" ]; then',
    '  printf "%s\\n" "$REMCP_TEST_PREFIX"',
    '  exit 0',
    'fi',
    'if [ "$1" = "install" ]; then',
    '  case " $* " in *" --prefer-online "*) ;; *) echo "update did not revalidate npm metadata" >&2; exit 94;; esac',
    '  test ! -e "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/remcp" || { echo "client tree was still live" >&2; exit 91; }',
    '  test ! -e "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime" || { echo "runtime tree was still live" >&2; exit 92; }',
    '  test ! -e "$REMCP_TEST_PREFIX/bin/remcp" || { echo "client bin was still live" >&2; exit 93; }',
    '  mkdir -p "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/remcp/bin"',
    '  mkdir -p "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime/src"',
    '  mkdir -p "$REMCP_TEST_PREFIX/bin"',
    '  printf \'{"name":"@remcp/remcp","version":"0.2.54"}\\n\' > "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/remcp/package.json"',
    '  printf "new-client\\n" > "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/remcp/bin/remcp.mjs"',
    '  printf \'{"name":"@remcp/runtime","version":"0.2.54"}\\n\' > "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime/package.json"',
    '  printf "new-runtime\\n" > "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime/src/index.mjs"',
    '  ln -s ../lib/node_modules/@remcp/remcp/bin/remcp.mjs "$REMCP_TEST_PREFIX/bin/remcp"',
    '  exit 0',
    'fi',
    'exit 0',
  ].join('\n');
  const { prefix, result } = runUpdateHelper(root, npmBody);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(readFileSync(path.join(packageDir(prefix, '@remcp/remcp'), 'bin', 'remcp.mjs'), 'utf8'), /new-client/);
  assert.match(readFileSync(path.join(packageDir(prefix, '@remcp/runtime'), 'src', 'index.mjs'), 'utf8'), /new-runtime/);
  assert.equal(lstatSync(path.join(prefix, 'bin', 'remcp')).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(prefix).filter(name => name.startsWith('.remcp-update-backup-')), []);
});

test('macOS global update restores the previous live pair when npm leaves a partial install', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remcp-mac-update-rollback-'));
  const npmBody = [
    'if [ "$1" = "prefix" ] && [ "$2" = "--global" ]; then',
    '  printf "%s\\n" "$REMCP_TEST_PREFIX"',
    '  exit 0',
    'fi',
    'if [ "$1" = "install" ]; then',
    '  test ! -e "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/remcp" || exit 91',
    '  test ! -e "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime" || exit 92',
    '  mkdir -p "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime/src"',
    '  mkdir -p "$REMCP_TEST_PREFIX/bin"',
    '  printf "partial-runtime\\n" > "$REMCP_TEST_PREFIX/lib/node_modules/@remcp/runtime/src/index.mjs"',
    '  rm -f "$REMCP_TEST_PREFIX/bin/remcp"',
    '  printf "partial-bin\\n" > "$REMCP_TEST_PREFIX/bin/remcp"',
    '  exit 73',
    'fi',
    'exit 0',
  ].join('\n');
  const { prefix, result } = runUpdateHelper(root, npmBody);
  assert.notEqual(result.status, 0, 'the simulated npm failure must reach the caller');
  assert.match(result.stderr, /exit code 73/, 'the helper must reach the simulated npm install failure before rolling back');
  assert.doesNotMatch(result.stderr, /does not provide an export named/, 'the rollback assertion must not pass because the helper is missing');
  assert.match(readFileSync(path.join(packageDir(prefix, '@remcp/remcp'), 'bin', 'remcp.mjs'), 'utf8'), /old-client/);
  assert.match(readFileSync(path.join(packageDir(prefix, '@remcp/runtime'), 'src', 'index.mjs'), 'utf8'), /old-runtime/);
  assert.equal(lstatSync(path.join(prefix, 'bin', 'remcp')).isSymbolicLink(), true, 'the old CLI bin link is restored too');
  assert.deepEqual(readdirSync(prefix).filter(name => name.startsWith('.remcp-update-backup-')), []);
  assert.equal(existsSync(path.join(packageDir(prefix, '@remcp/runtime'), 'src', 'partial-only')), false);
});
