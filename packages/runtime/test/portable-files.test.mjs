import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtimeRoot = fileURLToPath(new URL('..', import.meta.url));

test('portable document and archive paths remain available without Linux descriptor anchors', t => {
  const zipProbe = spawnSync('zip', ['-v'], { stdio:'ignore' });
  if (zipProbe.error?.code === 'ENOENT' || zipProbe.status !== 0) {
    t.skip('portable OOXML round-trip requires the optional zip CLI capability');
    return;
  }
  const script = String.raw`
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remcp-portable-files-'));
    Object.defineProperty(process, 'platform', { value:'darwin' });
    process.env.REMCP_RUNTIME_ALLOWED_ROOTS = root;
    process.env.REMCP_RUNTIME_DISABLE_TELEMETRY = '1';

    const docs = await import('./src/extended/documents.mjs');
    const files = await import('./src/tools/files.mjs');
    try {
      const xlsx = path.join(root, 'test.xlsx');
      const docx = path.join(root, 'test.docx');
      await docs.editSpreadsheet({ path:xlsx, create:true, sheet:'Sheet1', edits:[{ cell:'A1', value:'portable' }] });
      await docs.editSpreadsheet({ path:xlsx, sheet:'Sheet1', edits:[{ cell:'B2', value:42 }] });
      await docs.editDocument({ path:docx, create:true, operations:[{ action:'append_paragraph', text:'portable-doc' }] });
      await docs.editDocument({ path:docx, operations:[{ action:'append_paragraph', text:'second' }] });
      const read = await docs.readDocument({ path:docx });
      if (!JSON.stringify(read).includes('portable-doc')) throw new Error('portable document round-trip failed');

      const source = path.join(root, 'source');
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, 'a.txt'), 'archive-ok');
      const archive = path.join(root, 'bundle.tar.gz');
      await files.createArchiveTool({ paths:[source], destination:archive, format:'tar.gz' });
      const destination = path.join(root, 'unpacked');
      await files.extractArchiveTool({ archive, destination });
      const roundTrip = await fs.readFile(path.join(destination, 'source', 'a.txt'), 'utf8');
      if (roundTrip !== 'archive-ok') throw new Error('portable archive round-trip failed');
      process.stdout.write('portable-files-ok\\n');
    } finally {
      await fs.rm(root, { recursive:true, force:true });
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd:runtimeRoot,
    encoding:'utf8',
    timeout:30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /portable-files-ok/);
});
