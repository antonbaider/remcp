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
  assert.equal(mcp.mcpServers.remcp.url, 'https://remcp.site/mcp');
  const files = ['plugin.json', 'mcp.json'];
  const iface = plugin.extensions['com.openai'].interface;
  assert.deepEqual(iface.capabilities, ['Read', 'Write'], 'OpenAI interface declares the read/write capability shown by the actual tool surface');
  for (const asset of new Set([iface.logo, iface.composerIcon])) {
    assert.match(asset, /^\.\/assets\/[\w.-]+$/, 'icons must be bundled assets');
    files.push(asset.slice(2));
  }
  if (iface.screenshots !== undefined) {
    assert.ok(Array.isArray(iface.screenshots) && iface.screenshots.length > 0, 'screenshots must be a non-empty array when supplied');
    assert.equal(iface.screenshots.length, iface.defaultPrompt?.length || 0, 'OpenAI requires exactly one screenshot for each starter prompt when screenshots are supplied');
    const dimensions = buffer => {
      const isPng = buffer.length >= 24 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      if (isPng) return { type:'png', width:buffer.readUInt32BE(16), height:buffer.readUInt32BE(20) };
      if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 8 < buffer.length) {
          if (buffer[offset] !== 0xff) { offset += 1; continue; }
          const marker = buffer[offset + 1];
          offset += 2;
          if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
          if (offset + 2 > buffer.length) break;
          const length = buffer.readUInt16BE(offset);
          if (length < 2 || offset + length > buffer.length) break;
          if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
            return { type:'jpeg', height:buffer.readUInt16BE(offset + 3), width:buffer.readUInt16BE(offset + 5) };
          }
          offset += length;
        }
      }
      return null;
    };
    for (const asset of iface.screenshots) {
      assert.match(asset, /^\.\/assets\/[\w.-]+\.(?:png|jpe?g)$/i, 'screenshots must be bundled PNG or JPEG assets');
      const relative = asset.slice(2);
      const image = read(relative);
      const size = dimensions(image);
      assert.ok(size, `${relative} is a valid PNG or JPEG`);
      assert.equal(size.width, 706, `${relative} must be exactly 706 px wide`);
      assert.ok(size.height >= 400 && size.height <= 860, `${relative} height must be 400–860 px`);
      files.push(relative);
    }
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
    assert.match(metadata, /url: "https:\/\/remcp.site\/mcp"/);
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
