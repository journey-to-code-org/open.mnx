// The WebAssembly compiler against the native CLI: same output, same errors. Needs mnx.wasm
// (`npm run build`, which needs Rust's wasm32-unknown-unknown target; CI builds it) and the
// native CLI (`cargo build`). Skipped when mnx.wasm is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { available, compileFile, request, sources } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const fixtures = join(repo, 'runtime/test/browser/fixtures');
if (process.env.MNX_REQUIRE_WASM && !available()) throw new Error('MNX_REQUIRE_WASM is set but mnx.wasm is missing');
const skip = available() ? false : 'mnx.wasm is not built (npm run build)';
const cli = (...args) => execFileSync(join(repo, 'target/debug/mnix'), ['compile', ...args], { encoding: 'utf8' });

test('collects a component and the components it imports', () => {
  const files = sources(join(fixtures, 'inbox.mnx'));
  assert.deepEqual(Object.keys(files).map((path) => path.split('/').pop()).sort(), ['badge.mnx', 'inbox.mnx']);
});

test('every output matches the native CLI', { skip }, () => {
  for (const fixture of ['inbox', 'styled-page', 'typed', 'rating', 'card']) {
    const path = join(fixtures, `${fixture}.mnx`);
    for (const [emit, flags] of [['js', []], ['css', []], ['dts', []], ['manifest', ['--module-path', `${fixture}.js`]]]) {
      const response = compileFile(path, { emit, modulePath: `${fixture}.js` });
      assert.equal(response.ok, true, `${fixture} ${emit}: ${response.error}`);
      assert.equal(response.output, cli(path, '--emit', emit, ...flags), `${fixture} ${emit}`);
    }
  }
  const html = compileFile(join(repo, 'examples/header.mnx'));
  assert.equal(html.output, cli(join(repo, 'examples/header.mnx')).replace(/\n$/, ''));
});

test('errors and warnings come back rendered and as diagnostics', { skip }, () => {
  const response = request({ command: 'check', path: '/x.mnx', files: { '/x.mnx': '<mnx-x title="">\n  <p>{titel}</p>\n</mnx-x>' } });
  assert.equal(response.ok, false);
  assert.match(response.error, /^error: unknown reference `titel`/);
  assert.match(response.warnings[0], /^warning: prop `title`/);
  assert.deepEqual(response.diagnostics.map((d) => [d.severity, d.line, d.help]), [
    ['warning', 1, "rename the prop if that isn't intended (e.g. `title-text`)"],
    ['error', 2, 'did you mean `title`?'],
  ]);
});

test('large requests and many requests in a row', { skip }, () => {
  const big = `<mnx-big>${'<p>x</p>'.repeat(20000)}</mnx-big>`;
  for (let i = 0; i < 50; i++) {
    const response = request({ path: '/big.mnx', files: { '/big.mnx': big }, emit: 'js' });
    assert.equal(response.ok, true);
  }
});
