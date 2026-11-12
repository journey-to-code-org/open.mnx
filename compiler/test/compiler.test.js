// The WebAssembly compiler against the native CLI: same output, same errors. Needs zubra.wasm
// (`npm run build`, which needs Rust's wasm32-unknown-unknown target; CI builds it) and the
// native CLI (`cargo build`). Skipped when zubra.wasm is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { available, compileFile, request, sources } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const fixtures = join(repo, 'runtime/test/browser/fixtures');
if (process.env.ZUBRA_REQUIRE_WASM && !available()) throw new Error('ZUBRA_REQUIRE_WASM is set but zubra.wasm is missing');
const skip = available() ? false : 'zubra.wasm is not built (npm run build)';
const cli = (...args) => execFileSync(join(repo, 'target/debug/zubra'), ['compile', ...args], { encoding: 'utf8' });

test('collects a component and the components it imports', () => {
  const files = sources(join(fixtures, 'inbox.zb'));
  assert.deepEqual(Object.keys(files).map((path) => path.split('/').pop()).sort(), ['badge.zb', 'inbox.zb']);
});

test('collects a TypeScript component\'s TypeScript modules, and what they re-export', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zubra-sources-'));
  writeFileSync(join(directory, 'pick.zb'), "<script lang=\"ts\">\n  import { Size } from './index.js'\n  import './styles.css'\n</script>\n<zb-pick><p>{Size.Large}</p></zb-pick>\n");
  writeFileSync(join(directory, 'index.ts'), "export * from './sizes'\n");
  writeFileSync(join(directory, 'sizes.ts'), 'export const enum Size { Small, Large }\n');
  writeFileSync(join(directory, 'styles.css'), 'p {}\n');
  const files = sources(join(directory, 'pick.zb'));
  assert.deepEqual(Object.keys(files).map((path) => path.split('/').pop()).sort(), ['index.ts', 'pick.zb', 'sizes.ts']);
  // The same component in plain JavaScript reads nothing more.
  writeFileSync(join(directory, 'plain.zb'), "<script>\n  import { Size } from './index.js'\n</script>\n<zb-plain><p>x</p></zb-plain>\n");
  assert.deepEqual(Object.keys(sources(join(directory, 'plain.zb'))).map((path) => path.split('/').pop()), ['plain.zb']);
});

test('every output matches the native CLI', { skip }, () => {
  for (const fixture of ['inbox', 'styled-page', 'typed', 'enums', 'rating', 'card']) {
    const path = join(fixtures, `${fixture}.zb`);
    for (const [emit, flags] of [['js', []], ['css', []], ['dts', []], ['manifest', ['--module-path', `${fixture}.js`]]]) {
      const response = compileFile(path, { emit, modulePath: `${fixture}.js` });
      assert.equal(response.ok, true, `${fixture} ${emit}: ${response.error}`);
      assert.equal(response.output, cli(path, '--emit', emit, ...flags), `${fixture} ${emit}`);
    }
  }
  const html = compileFile(join(repo, 'examples/header.zb'));
  assert.equal(html.output, cli(join(repo, 'examples/header.zb')).replace(/\n$/, ''));
});

test('errors and warnings come back rendered and as diagnostics', { skip }, () => {
  const response = request({ command: 'check', path: '/x.zb', files: { '/x.zb': '<zb-x title="">\n  <p>{titel}</p>\n</zb-x>' } });
  assert.equal(response.ok, false);
  assert.match(response.error, /^error: unknown reference `titel`/);
  assert.match(response.warnings[0], /^warning: prop `title`/);
  assert.deepEqual(response.diagnostics.map((d) => [d.severity, d.line, d.help]), [
    ['warning', 1, "rename the prop if that isn't intended (e.g. `title-text`)"],
    ['error', 2, 'did you mean `title`?'],
  ]);
});

test('large requests and many requests in a row', { skip }, () => {
  const big = `<zb-big>${'<p>x</p>'.repeat(20000)}</zb-big>`;
  for (let i = 0; i < 50; i++) {
    const response = request({ path: '/big.zb', files: { '/big.zb': big }, emit: 'js' });
    assert.equal(response.ok, true);
  }
});
