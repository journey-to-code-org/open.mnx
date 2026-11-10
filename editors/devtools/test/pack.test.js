// `npm run pack`: the store zip, made with Node alone (no `zip` program, which Windows lacks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { files, zip } from '../scripts/pack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads a zip back through its central directory: { name: contents }. */
function unzip(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + archive.readUInt16LE(local + 26);
    out[name] = inflateRawSync(archive.subarray(start, start + size));
    at += 46 + nameLength;
  }
  return out;
}

test('the zip holds what the browser loads, manifest.json at its root, and nothing else', () => {
  const names = files();
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('devtools.html') && names.includes('pane.js') && names.includes('icons/icon-128.png'));
  for (const name of names) assert.doesNotMatch(name, /^(test|scripts)\/|^(package\.json|README\.md)$|\\/);
  // Everything the manifest and pages name is in it.
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  for (const path of [manifest.devtools_page, ...Object.values(manifest.icons)]) assert.ok(names.includes(path), path);
});

test('the archive reads back to the same bytes, and the same files make the same zip', () => {
  const names = files();
  const entries = names.map((name) => ({ name, data: readFileSync(join(root, name)) }));
  const archive = zip(entries);
  const back = unzip(archive);
  assert.deepEqual(Object.keys(back), names);
  for (const { name, data } of entries) assert.ok(back[name].equals(data), name);
  assert.ok(zip(entries).equals(archive), 'a repeatable build');
});
