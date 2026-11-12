// Which compiler the server uses: @zubra/compiler from the workspace being edited when it has one
// (the server can't find it from its own folder inside the VS Code extension), else the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutCompiler, createBackend, resolveCommand } from '../backend.js';
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
    const missing = await createBackend({ compiler: join(root, 'no-such-zubra'), onUnavailable: () => {} });
    assert.equal(missing.format('a.zb', '<x-a></x-a>', {}).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compiler from before the refactor command is reported as too old, not trusted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    // Older compilers ignore an unknown command and compile the file: the answer is JavaScript.
    const old = join(root, 'old-zubra');
    writeFileSync(old, '#!/bin/sh\ncat >/dev/null\necho \'{"ok":true,"output":"// compiled","error":null,"warnings":[],"diagnostics":[]}\'\n', { mode: 0o755 });
    const cli = await createBackend({ compiler: old });
    const answer = cli.refactor(join(root, 'a.zb'), '<x-a><p>x</p></x-a>', { start: 5, end: 13, tag: 'a-b' });
    assert.equal(answer.ok, false);
    assert.equal(answer.unsupported, true);
    // The WebAssembly build the same.
    mkdirSync(join(root, 'node_modules/@zubra/compiler'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@zubra/compiler/package.json'), '{"name":"@zubra/compiler","type":"module","main":"index.js"}');
    writeFileSync(join(root, 'node_modules/@zubra/compiler/index.js'), FAKE.replace('({ diagnostics: [] })', "({ ok: true, output: '// compiled', diagnostics: [] })"));
    const wasm = await createBackend({ root });
    assert.equal(wasm.name, 'wasm');
    assert.equal(wasm.refactor(join(root, 'a.zb'), '<x-a><p>x</p></x-a>', { start: 5, end: 13, tag: 'a-b' }).unsupported, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a refusal comes back as its reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    const refusing = join(root, 'refusing-zubra');
    writeFileSync(refusing, '#!/bin/sh\ncat >/dev/null\necho \'{"ok":false,"output":null,"error":"x","warnings":[],"diagnostics":[{"message":"the selection contains a <zb-slot>"}]}\'\n', { mode: 0o755 });
    const answer = (await createBackend({ compiler: refusing })).refactor(join(root, 'a.zb'), '<x-a></x-a>', { start: 0, end: 1, tag: 'a-b' });
    assert.deepEqual(answer, { ok: false, reason: 'the selection contains a <zb-slot>' });
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

// A CLI that answers `check` with one warning saying which it is.
const cliSaying = (path, word) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\ncat >/dev/null\necho '[{"file":"a.zb","line":1,"column":1,"severity":"warning","message":"${word}","help":null}]'\n`, { mode: 0o755 });
};
const fakeWasm = (dir, word) => {
  mkdirSync(join(dir, 'node_modules/@zubra/compiler'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/@zubra/compiler/package.json'), '{"name":"@zubra/compiler","type":"module","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules/@zubra/compiler/index.js'), FAKE.replace('({ diagnostics: [] })', `({ diagnostics: [{ message: '${word}' }] })`));
};

test("a compiler that can't be run is said once, not as an error in every file", async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    const told = [];
    const backend = await createBackend({ compiler: join(root, 'no-such-zubra'), onUnavailable: (message) => told.push(message) });
    assert.deepEqual(backend.check(join(root, 'a.zb'), '<x-a></x-a>'), []);
    assert.deepEqual(backend.check(join(root, 'b.zb'), '<x-b></x-b>'), []);
    assert.equal(backend.format(join(root, 'a.zb'), '<x-a></x-a>', {}).ok, false);
    assert.equal(told.length, 1);
    assert.match(told[0], /no-such-zubra.*ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('in a zubra checkout, the CLI cargo built is used, the newer of debug and release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  const saved = process.env.ZUBRA_COMPILER;
  delete process.env.ZUBRA_COMPILER;
  try {
    cliSaying(join(root, 'target/release/zubra'), 'release');
    cliSaying(join(root, 'target/debug/zubra'), 'debug');
    utimesSync(join(root, 'target/debug/zubra'), new Date(2000, 0, 1), new Date(2000, 0, 1));
    assert.equal(checkoutCompiler(join(root, 'examples/helpdesk')), join(root, 'target/release/zubra'), 'from a folder inside the checkout');
    const backend = await createBackend({ root: join(root, 'examples/helpdesk') });
    assert.equal(backend.name, 'cli');
    assert.equal(backend.check(join(root, 'a.zb'), '')[0].message, 'release');
    assert.equal(checkoutCompiler(mkdtempSync(join(tmpdir(), 'zubra-elsewhere-'))), null);
  } finally {
    if (saved !== undefined) process.env.ZUBRA_COMPILER = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a CLI built after the server started is found without restarting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  const saved = { compiler: process.env.ZUBRA_COMPILER, path: process.env.PATH };
  delete process.env.ZUBRA_COMPILER;
  process.env.PATH = join(root, 'empty');
  try {
    const told = [];
    const backend = await createBackend({ root, onUnavailable: (message) => told.push(message) });
    assert.deepEqual(backend.check(join(root, 'a.zb'), ''), []);
    assert.equal(told.length, 1);
    cliSaying(join(root, 'target/debug/zubra'), 'built');
    assert.equal(backend.check(join(root, 'a.zb'), '')[0].message, 'built');
  } finally {
    if (saved.compiler !== undefined) process.env.ZUBRA_COMPILER = saved.compiler;
    process.env.PATH = saved.path;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file in a project of its own below the workspace uses that project's @zubra/compiler", async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    fakeWasm(root, 'workspace');
    fakeWasm(join(root, 'examples/app'), 'app');
    const backend = await createBackend({ root });
    const file = join(root, 'examples/app/components/a.zb');
    await backend.prepare(file);
    assert.equal(backend.check(file, '')[0].message, 'app');
    assert.equal(backend.check(join(root, 'b.zb'), '')[0].message, 'workspace', 'files outside it still use the workspace one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('on Windows, `zubra` is looked up on PATH with its extensions (npm installs zubra.cmd)', () => {
  const files = new Set(['C:\\npm\\zubra.CMD', 'C:\\zubra\\target\\debug\\zubra.EXE']);
  const options = { platform: 'win32', env: { PATH: 'C:\\Windows;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, exists: (path) => files.has(path) };
  assert.equal(resolveCommand('zubra', options), 'C:\\npm\\zubra.CMD');
  assert.equal(resolveCommand('C:\\zubra\\target\\debug\\zubra', options), 'C:\\zubra\\target\\debug\\zubra.EXE', 'a path given without .exe');
  assert.equal(resolveCommand('C:\\tools\\zubra.exe', options), 'C:\\tools\\zubra.exe', 'one with an extension is run as given');
  assert.equal(resolveCommand('zubra', { ...options, platform: 'linux' }), 'zubra');
});

test("checking unsaved text gathers a package's component under its specifier", async () => {
  const root = mkdtempSync(join(tmpdir(), 'zubra-backend-'));
  try {
    mkdirSync(join(root, 'node_modules/@zubra/compiler'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@zubra/compiler/package.json'), '{"name":"@zubra/compiler","type":"module","main":"index.js"}');
    // A compiler that records what it's asked: sources() keys each file as it's told.
    writeFileSync(
      join(root, 'node_modules/@zubra/compiler/index.js'),
      `export const available = () => true;
       export const sources = (path, files = {}, key = path) => (files[key] = 'from ' + path, files);
       export const request = (body) => (globalThis.checked = body, { diagnostics: [] });
       export const compileFile = () => ({ ok: false });\n`,
    );
    mkdirSync(join(root, 'node_modules/@acme/kit/ui'), { recursive: true });
    writeFileSync(join(root, 'node_modules/@acme/kit/ui/cart-panel.zb'), '<cart-panel></cart-panel>\n');
    const backend = await createBackend({ root });
    const page = join(root, 'src/pages/shop-page.zb');
    backend.check(page, "<script>\n  import '@acme/kit/ui/cart-panel.zb'\n  import '@other/nope/x.zb'\n  import './local.zb'\n</script>\n<shop-page></shop-page>\n");
    const { files } = globalThis.checked;
    assert.equal(files['@acme/kit/ui/cart-panel.zb'], 'from ' + join(root, 'node_modules/@acme/kit/ui/cart-panel.zb'), 'found from a folder below node_modules, keyed by specifier');
    assert.equal(files[join(root, 'src/pages/local.zb')], 'from ' + join(root, 'src/pages/local.zb'));
    assert.equal(Object.keys(files).some((key) => key.includes('@other')), false, 'a package that is not installed adds nothing; the compiler says why');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
