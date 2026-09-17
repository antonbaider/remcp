#!/usr/bin/env node
// Dependency-free validation shared with the public npm/plugin repository.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkPlugin(root = fileURLToPath(new URL('..', import.meta.url))) {
  const read = file => readFileSync(join(root, file));
  const plugin = JSON.parse(read('plugin.json'));
  const pkg = JSON.parse(read('package.json'));
  const mcp = JSON.parse(read('mcp.json'));
  assert.equal(plugin.version, pkg.version, 'plugin and package versions must match');
  assert.equal(mcp.mcpServers.remcp.type, 'streamable-http');
  assert.equal(mcp.mcpServers.remcp.url, 'https://remcp.delio24.com/mcp');
  const files = ['plugin.json', 'mcp.json'];
  const iface = plugin.extensions['com.openai'].interface;
  for (const asset of new Set([iface.logo, iface.composerIcon])) {
    assert.match(asset, /^\.\/assets\/[\w.-]+$/, 'icons must be bundled assets');
    files.push(asset.slice(2));
  }
  const walk = relative => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `symlink cannot be bundled: ${file}`);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  const skills = readdirSync(join(root, 'skills'), { withFileTypes: true }).filter(entry => entry.isDirectory());
  assert.equal(skills.length, 5, 'all five ReMCP workflows must be exported');
  for (const { name } of skills) {
    const skillPath = `skills/${name}`;
    const md = read(`${skillPath}/SKILL.md`).toString();
    assert.ok(md.startsWith(`---\nname: ${name}\ndescription: `), `${name} front matter`);
    assert.match(md, /\ndescription: .+\n---\n/);
    const metadata = read(`${skillPath}/agents/openai.yaml`).toString();
    assert.match(metadata, /display_name: ".+"/);
    assert.match(metadata, /short_description: ".+"/);
    assert.match(metadata, /value: "remcp"/);
    assert.match(metadata, /transport: "streamable_http"/);
    assert.match(metadata, /url: "https:\/\/remcp.delio24.com\/mcp"/);
    walk(skillPath);
  }
  for (const file of files.filter(file => file.endsWith('.md'))) {
    for (const match of read(file).toString().matchAll(/\]\((references\/[^)#]+)(?:#[^)]*)?\)/g)) {
      assert.ok(files.includes(join(dirname(file), match[1])), `missing reference in ${file}: ${match[1]}`);
    }
  }
  // Validate the actual upload, not just the source tree. Our ZIP writer stores entries without
  // compression so this check runs in a bare checkout without installing an unzip dependency.
  const zip = read('submission/remcp-plugin.zip');
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0, 'archive entries must be stored');
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    assert.ok(start + size <= zip.length, 'truncated ZIP entry');
    assert.ok(!entries.has(name), `duplicate ZIP entry: ${name}`);
    entries.set(name, zip.subarray(start, start + size));
    offset = start + size;
  }
  assert.deepEqual([...entries.keys()].sort(), files.sort(), 'archive must contain the entire portable plugin');
  for (const file of files) assert.deepEqual(entries.get(file), read(file), `stale archive entry: ${file}`);
  return { skills: skills.length, files: files.length, version: plugin.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPlugin();
  console.log(`Plugin ${result.version}: ${result.skills} skills, ${result.files} files; archive matches source.`);
}
