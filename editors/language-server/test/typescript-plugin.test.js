// The TypeScript plugin, inside a real tsserver (the TypeScript this package ships): a `.ts` file
// that imports components gets their typings, kept up to date when a component is saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..');
const tsserver = createRequire(import.meta.url).resolve('typescript/lib/tsserver.js');
const compiler = process.env.ZUBRA_COMPILER ?? join(server, '../../target/debug/zubra');

/**
 * A project with the plugin in its tsconfig.json, and `files`. `withCompiler`: @zubra/compiler
 * installed too, which the plugin then uses (here it answers through ZUBRA_COMPILER, as it does
 * without its WebAssembly build); without it, the CLI.
 */
function project(files, { withCompiler = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'zubra-ts-plugin-'));
  mkdirSync(join(root, 'node_modules/@zubra'), { recursive: true });
  symlinkSync(server, join(root, 'node_modules/@zubra/language-server'), 'dir');
  if (withCompiler) symlinkSync(join(server, '../../compiler'), join(root, 'node_modules/@zubra/compiler'), 'dir');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, lib: ['ES2022', 'DOM'],
      plugins: [{ name: '@zubra/language-server/typescript-plugin' }],
    },
    include: ['src'],
  }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** tsserver, with the project as a place plugins load from (VS Code passes the extension's). */
function start(root) {
  const child = spawn(process.execPath, [tsserver, '--pluginProbeLocations', root], {
    env: { ...process.env, ZUBRA_COMPILER: compiler },
  });
  let buffer = Buffer.alloc(0);
  let seq = 0;
  const waiting = new Map();
  child.stdout.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const header = /Content-Length: (\d+)\r\n\r\n/.exec(buffer.toString('latin1'));
      if (!header) return;
      const start = header.index + header[0].length;
      const length = Number(header[1]);
      if (buffer.length < start + length) return;
      const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
      buffer = buffer.subarray(start + length);
      if (message.type === 'response') waiting.get(message.request_seq)?.(message);
    }
  });
  const send = (command, args) => new Promise((done) => {
    seq += 1;
    waiting.set(seq, done);
    child.stdin.write(`${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`);
  });
  return { send, stop: () => child.kill() };
}

const errors = async (send, file) => (await send('semanticDiagnosticsSync', { file })).body.map((d) => `${d.start.line}:${d.start.offset} TS${d.code}`);

const badge = (type) => `<script lang="ts">\n  declare const count: ${type}\n</script>\n<zb-badge count={0}><p>{count}</p></zb-badge>\n`;

test('a .ts file gets a component\'s typings, and their changes when it\'s saved', { timeout: 60_000 }, async (t) => {
  const root = project({
    'src/badge.zb': badge('number'),
    'src/main.ts': [
      "import Badge, { tag } from './badge.zb';",
      'const b = new Badge();',
      'b.count = "x";',
      'const t: "zb-wrong" = tag;',
      "import Element from './badge.zb?element';",
      'new Element().count = 1;',
      '',
    ].join('\n'),
  }, { withCompiler: true });
  const { send, stop } = start(root);
  t.after(() => { stop(); rmSync(root, { recursive: true, force: true }); });
  const file = join(root, 'src/main.ts');
  await send('open', { file });
  // The prop's type and the tag's, both from the component.
  assert.deepEqual(await errors(send, file), ['3:1 TS2322', '4:7 TS2322']);
  const info = await send('quickinfo', { file, line: 2, offset: 7 });
  assert.equal(info.body.displayString, 'const b: Badge');
  // Go to definition on the class lands in the component.
  const definition = await send('definition', { file, line: 2, offset: 15 });
  assert.ok(definition.body.some((entry) => entry.file === join(root, 'src/badge.zb')), JSON.stringify(definition.body));

  // Saved as a string prop: the assignment is fine now, and `new Element().count = 1` isn't.
  writeFileSync(join(root, 'src/badge.zb'), badge('string'));
  let now = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((done) => setTimeout(done, 250));
    now = await errors(send, file);
    if (!now.includes('3:1 TS2322')) break;
  }
  assert.deepEqual(now, ['4:7 TS2322', '6:1 TS2322']);

  // Saved the way many editors save, by replacing the file: still followed.
  writeFileSync(join(root, 'src/badge.next'), badge('number'));
  renameSync(join(root, 'src/badge.next'), join(root, 'src/badge.zb'));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((done) => setTimeout(done, 250));
    now = await errors(send, file);
    if (now.includes('3:1 TS2322')) break;
  }
  assert.deepEqual(now, ['3:1 TS2322', '4:7 TS2322']);
  // And a save after that one.
  await new Promise((done) => setTimeout(done, 300));
  writeFileSync(join(root, 'src/badge.zb'), badge('string'));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((done) => setTimeout(done, 250));
    now = await errors(send, file);
    if (!now.includes('3:1 TS2322')) break;
  }
  assert.deepEqual(now, ['4:7 TS2322', '6:1 TS2322']);
});

test('a component that doesn\'t compile imports as any, and a missing one is TypeScript\'s error', { timeout: 60_000 }, async (t) => {
  const root = project({
    'src/broken.zb': '<script lang="ts">\n  const x =\n</script>\n<zb-broken></zb-broken>\n',
    'src/main.ts': "import Broken from './broken.zb';\nimport Missing from './missing.zb';\nnew Broken();\n",
  });
  const { send, stop } = start(root);
  t.after(() => { stop(); rmSync(root, { recursive: true, force: true }); });
  const file = join(root, 'src/main.ts');
  await send('open', { file });
  assert.deepEqual(await errors(send, file), ['2:21 TS2307']);
});

test('a plain import is typed for the project\'s framework, as the build plugin compiles it', () => {
  const { projectFramework } = createRequire(import.meta.url)('../typescript-plugin/index.js');
  const root = mkdtempSync(join(tmpdir(), 'zubra-ts-plugin-'));
  const at = (name, manifest) => {
    mkdirSync(join(root, name, 'src'), { recursive: true });
    writeFileSync(join(root, name, 'package.json'), JSON.stringify(manifest));
    return projectFramework(join(root, name, 'src'));
  };
  assert.equal(at('react', { dependencies: { react: '19' } }), 'react');
  assert.equal(at('vue', { dependencies: { vue: '3', react: '19' } }), 'vue');
  assert.equal(at('solid', { devDependencies: { 'solid-js': '1' } }), 'solid');
  assert.equal(at('plain', { dependencies: { lit: '3' } }), 'none');
  rmSync(root, { recursive: true, force: true });
});
