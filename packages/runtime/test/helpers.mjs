import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function freshWorkspace(prefix) {
  const root = mkdtempSync(join(tmpdir(), `remcp-runtime-${prefix}-`));
  process.env.REMCP_RUNTIME_CONFIG_DIR = join(root, 'config');
  return root;
}

export function body(result) {
  return result.content.map(part => part.text).join('\n');
}

export function isError(result) {
  return result.isError === true;
}

export async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}
