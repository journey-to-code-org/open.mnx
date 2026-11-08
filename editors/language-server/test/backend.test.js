// Which compiler the server uses: @zubra/compiler from the workspace being edited when it has one
// (the server can't find it from its own folder inside the VS Code extension), else the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../backend.js';

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
