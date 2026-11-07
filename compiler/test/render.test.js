// Server rendering through @mnx/compiler. Uses mnx.wasm when it's built; otherwise the native
// CLI (`cargo build`) answers the same requests, so this runs without the wasm target too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const fixtures = join(repo, 'runtime/test/browser/fixtures');
const { available, render, renderToString, CompileError } = await import('../index.js');
if (!available()) process.env.MNX_COMPILER = join(repo, 'target/debug/mnx');

test('renders a component with props, slot HTML and the styles it needs', () => {
  const { html, css, warnings } = render(join(fixtures, 'styled-page.mnx'), {
    slots: {},
  });
  assert.match(html, /^<mnx-styled-page/);
  assert.match(css, /@scope \(mnx-styled-page\)/);
  assert.match(css, /@scope \(mnx-styled-card\)/, "the child component's stylesheet too");
  assert.deepEqual(warnings, []);

  const card = renderToString(join(fixtures, 'card.mnx'), {
    props: { heading: 'Mail' },
    slots: { default: '<p>{not an expression}</p><!--marker-->' },
  });
  assert.match(card, /<h2>Mail<\/h2>/);
  assert.match(card, /<p>\{not an expression\}<\/p><!--marker-->/);
});

test('errors are CompileErrors with diagnostics', () => {
  assert.throws(() => renderToString(join(fixtures, 'card.mnx'), { props: { open: 'yes' } }), (error) => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, /open/);
    assert.equal(error.diagnostics[0].severity, 'error');
    return true;
  });
  assert.throws(() => renderToString(join(fixtures, 'card.mnx'), { slots: { nope: '<p></p>' } }), /slot `nope` is not declared/);
});

test('what only the browser can compute is left for the element, unless partial is false', () => {
  const html = renderToString(join(fixtures, 'inline.mnx'));
  assert.match(html, /<p class="summary"><\/p>/, 'a state signal\'s .get() is left for the element');
  assert.match(html, /<li>#2 LINUS<\/li>/, 'the JavaScript the server can compute is rendered (2.8)');
  assert.throws(() => renderToString(join(fixtures, 'inline.mnx'), { partial: false }), /only exists at runtime|runs in the browser only/);
  // JSX components too.
  assert.match(renderToString(join(fixtures, 'jsx/rating.mnx.jsx'), { props: { label: 'Stars' } }), /<span class="label">Stars<\/span>/);
});
