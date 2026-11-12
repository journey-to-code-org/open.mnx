// `zubra check --types`: components checked by the project's own TypeScript (7.0.2 here), with
// each error placed back on the `.zb` line it came from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { available } from '../index.js';
import { checkTypes, components } from '../typecheck.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
process.env.ZUBRA_COMPILER ??= join(repo, 'target/debug/zubra');
const skip = !available() && !existsSync(process.env.ZUBRA_COMPILER) && 'needs zubra.wasm or target/debug/zubra';

/** A project: a tsconfig, @zubra/runtime's types, and `files`. */
function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'zubra-types-'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'] },
  }));
  mkdirSync(join(root, 'node_modules/@zubra'), { recursive: true });
  symlinkSync(join(repo, 'runtime'), join(root, 'node_modules/@zubra/runtime'), 'dir');
  // The project's own TypeScript, which `check --types` runs: this package's dev dependency.
  symlinkSync(join(repo, 'compiler/node_modules/typescript'), join(root, 'node_modules/typescript'), 'dir');
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

const badge = `<script lang="ts">
  import { emit } from '@zubra/runtime'
  declare const count: number
  function clear() { emit<{ cleared: boolean }>('clear', { cleared: true }) }
</script>
<zb-badge count={0} label="New"><span onclick={clear}>{label}: {count}</span></zb-badge>
`;

test('finds the components in folders, skipping node_modules', { skip }, () => {
  const root = project({ 'src/a.zb': badge, 'src/deep/b.zb': badge, 'src/node_modules/x/c.zb': badge, 'other.zb': badge });
  assert.deepEqual(components([join(root, 'src'), join(root, 'other.zb')]).map((file) => file.slice(root.length + 1)), ['other.zb', 'src/a.zb', 'src/deep/b.zb']);
});

test('type errors in templates, child props and handlers land on their .zb lines', { skip }, () => {
  const root = project({
    'src/badge.zb': badge,
    'src/inbox.zb': `<script lang="ts">
  import './badge.zb'
  import { state } from '@zubra/runtime'
  interface Message { id: number; subject: string }
  const messages: Message[] = [{ id: 1, subject: "Hi" }]
  const total = state(2)
  let unread = 3
  function cleared(event: CustomEvent<{ cleared: boolean }>) { if (event.detail.cleared) unread = 0 }
</script>
<zb-inbox>
  <zb-badge count={unread + total} onclear={cleared}></zb-badge>
  <zb-badge count={"many"} onclear={(event) => event.detail.clearedd}></zb-badge>
  <ul><zb-each items={messages} as="message"><li>{message.subjet}</li></zb-each></ul>
  <button onclick={(event) => event.clientXX}>x</button>
  <zb-if test={unread > 0}><p>{unread.toFixed(0)}</p></zb-if>
</zb-inbox>
`,
  });
  const { diagnostics, checked } = checkTypes([join(root, 'src')], { root });
  assert.equal(checked, 2);
  const found = diagnostics.map(({ file, line, column, code, message }) => `${file.slice(root.length + 1)}:${line}:${column} ${code} ${message.split('\n')[0]}`);
  assert.deepEqual(found, [
    "src/inbox.zb:12:20 TS2345 Argument of type 'string' is not assignable to parameter of type 'number'.",
    "src/inbox.zb:12:61 TS2551 Property 'clearedd' does not exist on type '{ cleared: boolean; }'. Did you mean 'cleared'?",
    "src/inbox.zb:13:59 TS2551 Property 'subjet' does not exist on type 'Message'. Did you mean 'subject'?",
    "src/inbox.zb:14:37 TS2551 Property 'clientXX' does not exist on type 'PointerEvent'. Did you mean 'clientX'?",
  ]);
  // `total` is a signal, and the template reads its value: `unread + total` is a number.
});

test('a clean project has no errors, and nothing is left beside the components', { skip }, () => {
  const root = project({ 'src/badge.zb': badge });
  const { diagnostics, out } = checkTypes([join(root, 'src')], { root });
  assert.deepEqual(diagnostics, []);
  assert.equal(existsSync(out), false);
});

test('one component, with the components it imports, and unsaved text in place of the file', { skip }, () => {
  const inbox = "<script lang=\"ts\">\n  import './badge.zb'\n</script>\n<zb-inbox><zb-badge count={1}></zb-badge></zb-inbox>\n";
  const root = project({ 'src/badge.zb': badge.replace('{count}', '{count.nope}'), 'src/inbox.zb': inbox });
  const file = join(root, 'src/inbox.zb');
  // Only what was asked for is reported: badge.zb's own error isn't.
  assert.deepEqual(checkTypes([file], { root }).diagnostics, []);
  const unsaved = inbox.replace('count={1}', 'count={"one"}');
  const { diagnostics } = checkTypes([file], { root, texts: { [file]: unsaved }, out: join(root, '.zubra-types', 'editor') });
  assert.deepEqual(diagnostics.map(({ line, column, code }) => [line, column, code]), [[4, 28, 'TS2345']]);
});

test('the CLI: errors on .zb lines, or as JSON for tooling, and exit 1', { skip }, async () => {
  const { spawnSync } = await import('node:child_process');
  const root = project({ 'src/badge.zb': badge.replace('{count}', '{count.nope}') });
  const cli = (...args) => spawnSync(process.execPath, [join(here, '../cli.js'), 'check', '--types', ...args], { cwd: root, encoding: 'utf8', env: process.env });
  const human = cli('src');
  assert.equal(human.status, 1);
  assert.match(human.stderr, /^src\/badge\.zb:6:\d+ - error TS2339: Property 'nope' does not exist on type 'number'\./m);
  const json = cli('src', '--format', 'json');
  assert.equal(json.status, 1);
  const [entry] = JSON.parse(json.stdout);
  assert.deepEqual({ ...entry, file: entry.file.slice(root.length + 1), column: undefined }, { file: 'src/badge.zb', line: 6, column: undefined, severity: 'error', message: "Property 'nope' does not exist on type 'number'.", help: null, code: 'TS2339' });
});
