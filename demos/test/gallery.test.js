// The built gallery, served under a base path the way GitHub Pages serves a project site: every
// live demo loads with no failed requests or errors, and draws its Zubra elements.
//
//   node demos/build.mjs --out _site --base /zubra/ && node --test "demos/test/*.test.js"
//
// GALLERY (default _site) and GALLERY_BASE (default /zubra/) say where the build is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../serve.mjs';
import { demos } from '../list.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const dir = resolve(repo, process.env.GALLERY ?? '_site');
const base = process.env.GALLERY_BASE ?? '/zubra/';
// Playwright from the framework examples' install (`npm ci` in examples/frameworks).
const { chromium } = createRequire(join(repo, 'examples/frameworks/package.json'))('playwright');

let browser;
let site;
before(async () => {
  assert.ok(existsSync(join(dir, 'index.html')), `no gallery in ${dir}: run node demos/build.mjs --out ${dir} --base ${base}`);
  site = await serve(dir, base);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  site?.close();
});

/** Open `path` (under the base); collects failed requests and errors. */
async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const problems = [];
  page.on('pageerror', (error) => problems.push(`error: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  page.on('response', (response) => { if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', (request) => problems.push(`failed: ${request.url()}`));
  await page.goto(new URL(path, site.url).href, { waitUntil: 'networkidle' });
  return { page, problems };
}

const live = demos.filter((demo) => demo.build && existsSync(join(dir, 'demos', demo.id, 'index.html')));

test('every static example is in the build', () => {
  assert.deepEqual(live.map((demo) => demo.id), demos.filter((demo) => demo.build).map((demo) => demo.id));
});

test('the gallery lists every example, and its links and images resolve under the base path', async () => {
  const { page, problems } = await open('');
  assert.equal(await page.locator('article.card').count(), demos.length);
  const links = await page.$$eval('a[href], img[src]', (nodes) => nodes.map((node) => node.href || node.src));
  const local = [...new Set(links.filter((link) => link.startsWith(site.url)))];
  assert.ok(local.length > live.length, 'it links to the demos');
  for (const link of local) {
    const response = await page.request.get(link);
    assert.equal(response.status(), 200, link);
  }
  assert.deepEqual(problems, []);
  await page.close();
});

for (const demo of live) {
  test(`${demo.id}: loads under ${base}demos/${demo.id}/ and draws its elements`, async () => {
    const first = await open(`demos/${demo.id}/`);
    assert.deepEqual(first.problems, []);
    await first.page.close();
    const { page, problems } = await open(`demos/${demo.id}/${demo.interactive ?? ''}`);
    // Zubra elements are defined and have rendered something (light DOM or a shadow root).
    const drawn = await page.waitForFunction(() => {
      const elements = [...document.querySelectorAll('*')].flatMap(function all(node) {
        return [node, ...(node.shadowRoot ? [...node.shadowRoot.querySelectorAll('*')].flatMap(all) : [])];
      }).filter((node) => node.localName.includes('-') && customElements.get(node.localName)?.zubra);
      const rendered = elements.filter((node) => (node.shadowRoot ?? node).childNodes.length);
      return rendered.length ? rendered.length : false;
    }, null, { timeout: 10_000 }).then((handle) => handle.jsonValue());
    assert.ok(drawn > 0);
    assert.deepEqual(problems, []);
    await page.close();
  });
}

test('the playground loads', { skip: !existsSync(join(dir, 'playground/index.html')) && 'not built' }, async () => {
  const { page, problems } = await open('playground/');
  await page.waitForSelector('textarea');
  // Without zubra.wasm (a local build) the playground says so; on Pages it compiles.
  const wasm = existsSync(join(dir, 'playground/zubra.wasm'));
  if (wasm) assert.deepEqual(problems, []);
  assert.match(readFileSync(join(dir, 'playground/index.html'), 'utf8'), /playground/);
  await page.close();
});

test('the landing page runs its own Zubra component: Copy puts the install command on the clipboard', async () => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(new URL('', site.url).href);
  await page.waitForSelector('copy-button:state(hydrated)');
  const button = page.locator('copy-button .copy');
  assert.equal((await button.innerText()).trim(), 'Copy');
  await button.click();
  await page.waitForFunction(() => document.querySelector('copy-button .copy').textContent.trim() === 'Copied!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'npm create zubra@latest');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the landing page\'s stripe bar stops under the header when scrolled to, as part of it', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(new URL('', site.url).href);
  const rects = () => page.evaluate(() => ({
    header: document.querySelector('.top').getBoundingClientRect().bottom,
    stripes: document.querySelector('.stripes').getBoundingClientRect().top,
  }));
  const before = await rects();
  assert.ok(before.stripes > before.header, 'it starts further down the page');
  await page.evaluate(() => scrollTo(0, 2000));
  const after = await rects();
  assert.equal(after.stripes, after.header, 'it sits right under the header once scrolled');
  await page.close();
});

test('the landing page\'s Zubra source wraps its comments instead of scrolling sideways, on a phone', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await page.goto(new URL('', site.url).href);
  const [scroll, client] = await page.evaluate(() => {
    const code = document.querySelector('.versus .side:first-child .code');
    return [code.scrollWidth, code.clientWidth];
  });
  assert.equal(scroll, client, 'nothing to scroll to');
  await page.close();
});
