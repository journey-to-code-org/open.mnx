// zubra components on a server: compiled modules load without a DOM, and render through the
// registry the build plugin's server output fills. Needs `cargo build` at the repository root.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canRender, registerRenderer, renderToString } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const mnix = join(repo, 'target/debug/zubra');
execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
// Inside the package, so `@zubra/runtime` resolves to it.
const dir = join(here, `.server-${process.pid}`);
mkdirSync(dir, { recursive: true });
after(() => rmSync(dir, { recursive: true, force: true }));

async function load(fixture) {
  const path = join(dir, `${fixture}.js`);
  writeFileSync(path, execFileSync(mnix, ['compile', join(here, 'browser/fixtures', `${fixture}.zb`), '--emit', 'js'], { encoding: 'utf8' }));
  return (await import(pathToFileURL(path).href)).default;
}

test('a compiled module loads without a DOM, as a stand-in with its description', async () => {
  assert.equal(typeof HTMLElement, 'undefined');
  const Card = await load('card');
  assert.equal(Card.zubra.tag, 'zb-card');
  assert.deepEqual(Card.zubra.slots, ['default', 'title']);
  assert.deepEqual(Object.keys(Card.zubra.props), ['heading', 'open']);
  assert.throws(() => new Card(), /can't be created without a DOM/);
  assert.equal(await load('card'), Card, 'one stand-in per tag');
});

test('renderToString() uses the registered renderer, with host attributes', async () => {
  const Card = await load('card');
  assert.equal(canRender(Card), false);
  assert.throws(() => renderToString(Card), /no server renderer for <zb-card>/);
  registerRenderer('zb-card', (props, slots) => execFileSync(mnix, ['request'], {
    input: JSON.stringify({ path: '/card.zb', files: { '/card.zb': CARD }, props, slots, slotSource: 'html' }),
    encoding: 'utf8',
  }).replace(/^[^]*"output":("(?:[^"\\]|\\.)*")[^]*$/, (_, output) => JSON.parse(output)));
  assert.equal(canRender(Card), true);
  assert.equal(canRender(class {}), false);
  const html = renderToString(Card, {
    props: { heading: 'Mail' }, attributes: { class: 'big "one"', hidden: true, id: null }, slots: { title: '<h2>{T}</h2>' },
  });
  assert.match(html, /^<zb-card class="big &quot;one&quot;" hidden heading="Mail">/);
  assert.match(html, /<header><\?zb \[!\?><h2>\{T\}<\/h2><\?zb \]\?><\/header>/);
  assert.throws(() => renderToString(Card, { slots: { nope: '' } }), /<zb-card> has no slot `nope`/);
  assert.throws(() => renderToString({}), /needs a compiled zubra element/);
});

const CARD = `<zb-card heading="Card" open={true}>
  <article>
    <header><zb-slot name="title"><h2>{heading}</h2></zb-slot></header>
    <zb-if test={open}><section><zb-slot><p>No content</p></zb-slot></section></zb-if>
  </article>
</zb-card>`;
