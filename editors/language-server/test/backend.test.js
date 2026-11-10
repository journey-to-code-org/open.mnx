// Which compiler the server uses: @zubra/compiler from the workspace being edited when it has one
// (the server can't find it from its own folder inside the VS Code extension), else the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../backend.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const FAKE = 'export const available = () => true; export const sources = () => ({}); export const request = () => ({ diagnostics: [] }); export const compileFile = () => ({ ok: false });\n';

test('@zubra/compiler in the workspace is used, even from a folder below it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    mkdirSync(join(root, 'node_modules/@zubra/compiler'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@zubra/compiler/package.json'), '{"name":"@zubra/compiler","type":"module","main":"index.js"}');
    writeFileSync(join(root, 'node_modules/@zubra/compiler/index.js'), FAKE);
    mkdirSync(join(root, 'packages/app'), { recursive: true });
    assert.equal((await createBackend({ root })).name, 'wasm');
    assert.equal((await createBackend({ root: join(root, 'packages/app') })).name, 'wasm', 'a hoisted install above the workspace folder');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('without one, or with a compiler named, it uses the CLI', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    assert.equal((await createBackend({ root })).name, 'cli');
    mkdirSync(join(root, 'node_modules/@zubra/compiler'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@zubra/compiler/package.json'), '{"name":"@zubra/compiler","type":"module","main":"index.js"}');
    writeFileSync(join(root, 'node_modules/@zubra/compiler/index.js'), FAKE);
    assert.equal((await createBackend({ root, compiler: 'zubra' })).name, 'cli', 'the setting wins');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both backends format, and pass the layout options on', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    mkdirSync(join(root, 'node_modules/@zubra/compiler'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@zubra/compiler/package.json'), '{"name":"@zubra/compiler","type":"module","main":"index.js"}');
    // A stand-in that answers with the request it got, as the formatted text.
    writeFileSync(join(root, 'node_modules/@zubra/compiler/index.js'), FAKE.replace('export const request = () => ({ diagnostics: [] });', 'export const request = (body) => ({ ok: true, output: JSON.stringify(body) });'));
    const wasm = await createBackend({ root });
    const request = JSON.parse(wasm.format(join(root, 'a.zb'), '<x-a></x-a>', { indentWidth: 4, useTabs: false, printWidth: 80 }).output);
    assert.deepEqual(request, { command: 'format', path: join(root, 'a.zb'), files: { [join(root, 'a.zb')]: '<x-a></x-a>' }, indentWidth: 4, useTabs: false, printWidth: 80 });

    const cli = await createBackend({ compiler: join(here, '../../../target/debug/zubra') });
    assert.deepEqual(cli.format('a.zb', '<x-a>\n<p>a</p>\n</x-a>', { indentWidth: 4 }), { ok: true, output: '<x-a>\n    <p>a</p>\n</x-a>\n' });
    assert.equal(cli.format('a.zb', '<x-a>\n<p>\n</x-a>', {}).ok, false);
    const missing = await createBackend({ compiler: join(root, 'no-such-zubra') });
    assert.equal(missing.format('a.zb', '<x-a></x-a>', {}).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compiler from before range formatting is reported as too old, not trusted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    const old = join(root, 'old-zubra');
    writeFileSync(old, '#!/bin/sh\ncat >/dev/null\necho \'{"ok":true,"output":"// compiled","error":null,"warnings":[],"diagnostics":[]}\'\n', { mode: 0o755 });
    const answer = (await createBackend({ compiler: old })).formatRange(join(root, 'a.zb'), '<x-a></x-a>', { start: 0, end: 3 }, {});
    assert.equal(answer.ok, false);
    assert.equal(answer.unsupported, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
