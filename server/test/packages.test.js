// Components from a package: `createZubra({ packages })` puts a package's folder of components
// beside the app's, a component imports them by specifier, and the page hydrates them through
// one import map entry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createZubra } from '../src/index.js';

let root;
let browser;
const components = () => join(root, 'components');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'zubra-server-packages-'));
  const kit = join(root, 'node_modules/@acme/kit');
  mkdirSync(join(kit, 'components'), { recursive: true });
  writeFileSync(join(kit, 'package.json'), JSON.stringify({ name: '@acme/kit', exports: { './components/*': './components/*' } }));
  writeFileSync(join(kit, 'components/kit-count.zb'), '<kit-count count:model={1}>\n  <output>{count}</output>\n  <button type="button" onclick={() => (count = count + 1)}>+</button>\n</kit-count>\n');
  writeFileSync(join(kit, 'components/cart-panel.zb'), "<script>\n  import './kit-count.zb'\n</script>\n<cart-panel title=\"Cart\">\n  <h2>{title}</h2>\n  <kit-count count={2}></kit-count>\n</cart-panel>\n");
  mkdirSync(components());
  writeFileSync(join(components(), 'shop-page.zb'), "<script>\n  import '@acme/kit/components/cart-panel.zb'\n</script>\n<shop-page>\n  <cart-panel title=\"Your cart\"></cart-panel>\n</shop-page>\n");
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  rmSync(root, { recursive: true, force: true });
});

test("an app component renders a package's component, and its own child", () => {
  const zubra = createZubra({ components: components(), packages: ['@acme/kit/components'], cache: false });
  const html = zubra.page().render('shop-page');
  assert.match(html, /<h2>Your cart<\/h2>/);
  assert.match(html, /<kit-count[^>]*>\s*<output>2<\/output>/);
});

test('a package component renders by name and by tag', () => {
  const zubra = createZubra({ components: components(), packages: ['@acme/kit/components'], cache: false });
  assert.match(zubra.page().render('@acme/kit/components/cart-panel'), /<h2>Cart<\/h2>/);
  assert.match(zubra.page().render('cart-panel', { title: 'By tag' }), /<h2>By tag<\/h2>/);
});

test('the import map sends the package to the component route, which serves its modules', async () => {
  const zubra = createZubra({ components: components(), packages: ['@acme/kit/components'], cache: false });
  const page = zubra.page();
  page.render('shop-page');
  const map = JSON.parse(page.head().match(/<script type="importmap">(.*?)<\/script>/)[1]);
  assert.equal(map.imports['@acme/kit/components/'], '/_zubra/components/@acme/kit/components/');
  assert.match(zubra.module('shop-page'), /import "@acme\/kit\/components\/cart-panel\.js"/);
  assert.match(zubra.module('@acme/kit/components/cart-panel'), /import "\.\/kit-count\.js"/);
});

test('in a browser: the page hydrates, and the package component inside the app one works', async () => {
  const zubra = createZubra({ components: components(), packages: ['@acme/kit/components'], cache: false });
  const server = createServer((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page.finish(`<!doctype html><html><head></head><body>${page.render('shop-page')}</body></html>`));
  });
  await new Promise((done) => server.listen(0, done));
  const tab = await browser.newPage();
  const problems = [];
  tab.on('pageerror', (error) => problems.push(error.message));
  tab.on('response', (response) => response.status() >= 400 && problems.push(`${response.status()} ${response.url()}`));
  try {
    await tab.goto(`http://localhost:${server.address().port}/`);
    await tab.waitForFunction(() => ['shop-page', 'cart-panel', 'kit-count'].every((tag) => customElements.get(tag)));
    await tab.click('kit-count button');
    await tab.waitForSelector('kit-count output:has-text("3")');
    assert.deepEqual(problems, []);
  } finally {
    await tab.close();
    server.close();
  }
});

test('a package that is missing, or a file instead of a folder, is refused at start', () => {
  assert.throws(() => createZubra({ components: components(), packages: ['@acme/nope/components'] }), /packages: @acme\/nope isn't installed/);
  assert.throws(() => createZubra({ components: components(), packages: ['@acme/kit/components/cart-panel.zb'] }), /is a file; name the folder/);
  assert.throws(() => createZubra({ components: components(), packages: ['@acme/kit/secret'] }), /@acme\/kit doesn't export \.\/secret/);
});

test('an app component and a package component with one tag: rendering by tag says which two', () => {
  const dir = join(root, 'clash');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'my-cart.zb'), '<cart-panel><p>mine</p></cart-panel>\n');
  const zubra = createZubra({ components: dir, packages: ['@acme/kit/components'], cache: false });
  assert.throws(() => zubra.page().render('cart-panel'), /<cart-panel> is defined by both my-cart and @acme\/kit\/components\/cart-panel/);
  assert.match(zubra.page().render('my-cart'), /mine/);
  assert.match(zubra.page().render('@acme/kit/components/cart-panel'), /<h2>Cart<\/h2>/, 'by name, either still renders');
});
