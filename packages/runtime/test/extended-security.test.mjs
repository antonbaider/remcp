import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { environmentTool } from '../src/extended/diagnostics.mjs';
import { runWithInput, safeEnvironment } from '../src/extended/common.mjs';

test('environment variables are opt-in and credential-bearing values are redacted', async t => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    SAFE_FIXTURE: process.env.SAFE_FIXTURE,
    OPAQUE_URL: process.env.OPAQUE_URL,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.DATABASE_URL = 'postgres://user:pass@localhost/db';
  process.env.REDIS_URL = 'redis://:secret@localhost:6379';
  process.env.SAFE_FIXTURE = 'visible';
  process.env.OPAQUE_URL = 'https://user:pass@example.test/path';

  const base = JSON.parse((await environmentTool({})).content[0].text);
  assert.equal(Object.hasOwn(base, 'environment'), false, 'environment values must be opt-in');

  const withEnv = JSON.parse((await environmentTool({ include_env: true })).content[0].text);
  assert.equal(withEnv.environment.DATABASE_URL, '***');
  assert.equal(withEnv.environment.REDIS_URL, '***');
  assert.equal(withEnv.environment.OPAQUE_URL, '***');
  assert.equal(withEnv.environment.SAFE_FIXTURE, 'visible');

  const sanitized = safeEnvironment();
  assert.equal(sanitized.DATABASE_URL, '***');
});

test('runWithInput bounds child stdout and stderr before buffering them in memory', async () => {
  await assert.rejects(
    () => runWithInput(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], '', { label: 'bounded fixture', maxBuffer: 1024 }),
    /exceeded the 1024 byte output limit/,
  );
});
