// @zubra/server tells the browser every module a page loads (`<link rel="modulepreload">`), so
// it fetches them at once instead of finding each level by parsing the one before
// (plan: roadmap-footprint F0).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createZubra } from '../src/index.js';
import { resolveSpecifier, staticImports } from '../src/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, 'components');
const layout = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
const preloaded = (html) => [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((match) => match[1]);

let browser;
const servers = [];
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.close();
});
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test('staticImports: imports and re-exports, minified or not, and never import()', () => {
  const code = [
    'import{a as b}from"./x.js";export*from"./y.js";import "./z.js";',
    "import d, { e } from '@zubra/runtime';",
    'const lazy = import("./lazy.js");',
    'export { default } from "/abs.js";',
    'import * as ns from "./ns.js";',
    'export const from = 1; thing.import("./method.js");',
  ].join('\n');
  assert.deepEqual(staticImports(code), ['./x.js', './y.js', './z.js', '@zubra/runtime', '/abs.js', './ns.js']);
});

test('resolveSpecifier: relative to the importing module, through the import map, or not ours', () => {
  const map = { '@zubra/runtime': '/_zubra/runtime/index.js', 'pkg/': '/vendor/pkg/' };
  assert.equal(resolveSpecifier('./badge.js', '/_zubra/components/table.js', map), '/_zubra/components/badge.js');
  assert.equal(resolveSpecifier('../runtime/effect.js', '/_zubra/components/table.js', map), '/_zubra/runtime/effect.js');
  assert.equal(resolveSpecifier('/abs.js', '/_zubra/components/table.js', map), '/abs.js');
  assert.equal(resolveSpecifier('@zubra/runtime', '/_zubra/components/table.js', map), '/_zubra/runtime/index.js');
  assert.equal(resolveSpecifier('pkg/deep/x.js', '/_zubra/components/table.js', map), '/vendor/pkg/deep/x.js');
  assert.equal(resolveSpecifier('unmapped', '/_zubra/components/table.js', map), null);
  assert.equal(resolveSpecifier('https://cdn.example/x.js', '/_zubra/components/table.js', map), null);
  assert.equal(resolveSpecifier('//cdn.example/x.js', '/_zubra/components/table.js', map), null);
});

test('a page preloads its components, what they import and the runtime, each once, after the import map', () => {
  const zubra = createZubra({ components, production: true });
  const page = zubra.page();
  page.render('order-form', {});
  const html = page.finish(layout(''));
  const links = preloaded(html);
  assert.equal(links[0], '/_zubra/components/order-form.js', "the page's own components first");
  assert.ok(links.includes('/_zubra/components/count-stepper.js'), 'a component another imports');
  assert.ok(links.includes('/_zubra/runtime/index.js'), "the runtime's entry, through the import map");
  assert.ok(links.includes('/_zubra/runtime/element.js') && links.includes('/_zubra/runtime/signal-impl.js'), "and the entry's own modules, levels down");
  assert.equal(new Set(links).size, links.length, 'each once');
  assert.ok(html.indexOf('<script type="importmap">') < html.indexOf('<link rel="modulepreload"'), 'after the import map');
  assert.ok(html.indexOf('<link rel="modulepreload"') < html.indexOf('</head>'), 'in the head');
  // Every link is a module the server has.
  for (const link of links) assert.equal(typeof link === 'string' && link.startsWith('/_zubra/'), true);
});

test('preload: false leaves the links out; anything else is refused', () => {
  const zubra = createZubra({ components, preload: false });
  const page = zubra.page();
  page.render('hello-there', { name: 'Ada', items: [] });
  assert.deepEqual(preloaded(page.finish(layout(''))), []);
  assert.throws(() => createZubra({ components, preload: 'yes' }), /preload is true or false/);
});

test("text that only looks like an import (in a string) isn't preloaded", () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-preload-'));
  try {
    writeFileSync(join(dir, 'code-hint.zb'), `<script>\n  let shown = "import theme from './missing.js'"\n</script>\n<code-hint>\n  <button onclick={() => (shown = '')}>{shown}</button>\n</code-hint>\n`);
    const zubra = createZubra({ components: dir });
    const page = zubra.page();
    page.render('code-hint', {});
    const links = preloaded(page.finish(layout('')));
    assert.ok(links.includes('/_zubra/components/code-hint.js'));
    assert.deepEqual(links.filter((link) => link.includes('missing')), [], 'the server has no such module');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clientModules: 'needed': a component that gets no module gets no preload", () => {
  const zubra = createZubra({ components, clientModules: 'needed' });
  const page = zubra.page();
  page.render('book-card', {});
  assert.deepEqual(preloaded(page.finish(layout(''))), [], 'book-card is complete on the server');
  const both = zubra.page();
  both.render('book-card', {});
  both.render('hello-there', { name: 'Ada', items: [] });
  const links = preloaded(both.finish(layout('')));
  assert.ok(links.includes('/_zubra/components/hello-there.js'));
  assert.ok(!links.includes('/_zubra/components/book-card.js'));
});

test('with a nonce, each link carries it; with inline: false, the links follow the stylesheets', () => {
  const nonce = 'c29tZSByYW5kb20gYnl0ZXM=';
  const withNonce = createZubra({ components }).page({ nonce });
  withNonce.render('hello-there', { name: 'Ada', items: [] });
  const html = withNonce.finish(layout(''));
  const links = html.match(/<link rel="modulepreload"[^>]*>/g);
  assert.ok(links.length > 1);
  for (const link of links) assert.ok(link.includes(` nonce="${nonce}"`), link);

  const plain = createZubra({ components, inline: false }).page();
  plain.render('hello-there', { name: 'Ada', items: [] });
  const linked = plain.finish(layout(''));
  assert.doesNotMatch(linked, /importmap/);
  assert.ok(preloaded(linked).includes('/_zubra/runtime/index.js'), 'the modules are served with their imports resolved, and read that way');
  assert.ok(linked.indexOf('rel="stylesheet"') < linked.indexOf('rel="modulepreload"'));
});

test('in a browser: the preloaded modules are exactly the ones the page loads, and it hydrates', async () => {
  const zubra = createZubra({ components, production: true });
  let html;
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const body = page.render('order-form', {});
    html = page.finish(layout(body));
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const requested = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  page.on('request', (request) => request.resourceType() === 'script' && requested.push(new URL(request.url()).pathname));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => customElements.get('order-form') && customElements.get('count-stepper'));
  assert.deepEqual(errors, [], 'no warning for a preload that went unused, no error');
  assert.deepEqual([...new Set(requested)].sort(), preloaded(html).sort(), 'nothing loaded that was not preloaded, nothing preloaded that was not loaded');
  assert.equal(requested.length, new Set(requested).size, 'and each fetched once: the preload and the import are one request');
  await context.close();
});

test('in a browser, under a nonce-only policy: the preloads are allowed and the page hydrates', async () => {
  const nonce = 'c29tZSByYW5kb20gYnl0ZXM=';
  const zubra = createZubra({ components });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page({ nonce });
    const body = page.render('hello-there', { name: 'Ada', items: [{ label: 'a', on: true }] });
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': `default-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' 'strict-dynamic'` }).end(page.finish(layout(body)));
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('hello-there p').textContent.startsWith('Hello Ada!'));
  assert.deepEqual(errors, []);
  await context.close();
});
