// @zubra/server: pages for template engines, the adapters, and shadow roots for framework HTML.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createZubra } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, 'components');
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function open(url, { javascript = true, before } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: javascript });
  const page = await context.newPage();
  if (before) await page.addInitScript(before);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  await page.goto(url);
  page.errors = errors;
  page.done = () => context.close();
  return page;
}
const layout = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

test('imports adds import map entries for other packages the components import', () => {
  const zubra = createZubra({ components, imports: { '@zubra/sync': '/sync/index.js' } });
  const html = zubra.page().finish('<html><head></head><body></body></html>');
  assert.match(html, /"@zubra\/runtime":"\/_zubra\/runtime\/index\.js"/);
  assert.match(html, /"@zubra\/sync":"\/sync\/index\.js"/);
});

test("a value that isn't a safe URL is left out, the page still renders, and the server says what it dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-omitted-'));
  try {
    writeFileSync(join(dir, 'farm-logo.zb'), '<farm-logo src="" name=""><img src={src} alt={name}></farm-logo>\n');
    const warned = [];
    const zubra = createZubra({ components: dir, warn: (message) => warned.push(message) });
    const page = zubra.page();
    const html = page.render('farm-logo', { src: 'data:text/html,<script>alert(1)</script>', name: 'Hollow Creek' });
    assert.match(html, /<img alt="Hollow Creek">/);
    assert.deepEqual(warned, ["@zubra/server: <farm-logo>: left `src` out of the HTML: its value isn't a safe URL (`data:text/html,<script>a…`)"]);
    page.render('farm-logo', { src: '/logos/hollow-creek.webp', name: 'Hollow Creek' });
    assert.equal(warned.length, 1, 'a safe URL says nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page: render, finish (CSS, import map, modules), and the browser modules served by handle()', async () => {
  const zubra = createZubra({ components });
  assert.deepEqual(zubra.names, ['book-card', 'count-stepper', 'hello-there', 'id-field', 'order-form', 'review-list', 'review-panel', 'slot-child', 'slot-frame']);
  assert.equal(zubra.describe('count-stepper').form, true);
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const body = page.render('hello-there', { name: 'Ada', items: [{ label: 'a', on: true }, { label: 'b' }, { label: 'c', on: true }] });
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
  });
  const html = await (await fetch(url)).text();
  assert.match(html, /<p>Hello Ada\. a, c<\/p>/, 'rendered on the server, JavaScript (filter, map, join) included');
  assert.match(html, /<style data-zb-components>[^]*color: rgb\(0, 128, 0\)/);
  assert.match(html, /"@zubra\/runtime":"\/_zubra\/runtime\/index\.js"/);
  assert.match(html, /import '\/_zubra\/components\/hello-there\.js';<\/script>\n?<\/body>/);
  assert.equal((await fetch(`${url}/_zubra/components/nope.js`)).status, 404);
  // (fetch() would normalize the dots away: send the path as written.)
  const { request } = await import('node:http');
  const body = await new Promise((resolve) => request(`${url}/`, { path: '/_zubra/runtime/../../package.json' }, (response) => {
    let text = '';
    response.on('data', (chunk) => (text += chunk)).on('end', () => resolve(text));
  }).end());
  assert.doesNotMatch(body, /"name": "@zubra\/runtime"/, 'no way out of the runtime folder (the dots resolve first)');
  const page = await open(url);
  await page.waitForFunction(() => document.querySelector('hello-there p').textContent.startsWith('Hello Ada!'));
  assert.deepEqual(page.errors, [], 'it hydrated the server markup');
  await page.done();
});

test('ids from id(): each render on a page gets its own, linked before JavaScript and kept after', async () => {
  const zubra = createZubra({ components });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const body = page.render('id-field', { label: 'First' }) + page.render('id-field', { label: 'Last' });
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
  });
  const read = (page) => page.$$eval('id-field', (fields) => fields.map((field) => [field.querySelector('input').id, field.querySelector('label').control === field.querySelector('input')]));
  const plain = await open(url, { javascript: false });
  const before = await read(plain);
  assert.deepEqual(before, [['id-field-s1-1', true], ['r2-id-field-s1-1', true]], 'two renders, two sets of ids');
  await plain.done();
  const page = await open(url);
  await page.waitForFunction(() => customElements.get('id-field'));
  await page.evaluate(() => Promise.all([...document.querySelectorAll('id-field')].map((el) => el.updateComplete)));
  await page.evaluate(() => { for (const field of document.querySelectorAll('id-field')) field.more = true; });
  await page.evaluate(() => Promise.all([...document.querySelectorAll('id-field')].map((el) => el.updateComplete)));
  assert.deepEqual(await page.$$eval('id-field output', (outputs) => outputs.map((output) => output.htmlFor.value)), ['id-field-s1-1', 'r2-id-field-s1-1'], 'the elements use them');
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('page.provide(): every component the page renders gets the value, on the server and after hydrating', async () => {
  const zubra = createZubra({ components: join(here, 'context-components') });
  assert.throws(() => zubra.page().provide('theme', 'dark'), /takes \{ module/);
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const before = page.render('ctx-themed');
    page.provide({ module: './theme.js', export: 'theme' }, 'dark');
    const body = before + page.render('ctx-themed') + page.render('ctx-themed');
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
  });
  const html = await (await fetch(url)).text();
  assert.equal((html.match(/<p class="dark">dark<\/p>/g) ?? []).length, 2, 'the two rendered after provide()');
  // The module the component imports is served from the components folder, and nothing outside it.
  assert.equal((await fetch(`${url}/_zubra/components/theme.js`)).status, 200);
  const { request } = await import('node:http');
  // (Dots are resolved before the request reaches us; an encoded slash isn't, and is decoded after.)
  const status = await new Promise((resolve) => request(`${url}/`, { path: '/_zubra/components/..%2F..%2Fsrc%2Findex.js' }, (response) => resolve(response.statusCode)).end());
  assert.equal(status, 404, 'no way out of the components folder');
  assert.match(html, /<ctx-themed>\s*<p><\/p>/, 'the one before: its default is left to the browser');
  const page = await open(url);
  await page.waitForFunction(() => customElements.get('ctx-themed'));
  await page.evaluate(() => Promise.all([...document.querySelectorAll('ctx-themed')].map((el) => el.updateComplete)));
  assert.deepEqual(await page.$$eval('ctx-themed p', (ps) => ps.map((p) => p.textContent)), ['light', 'dark', 'dark'], 'the elements start from the page\'s value');
  assert.deepEqual(page.errors, []);
  await page.done();
});

test("clientModules: 'needed': a card with an optional slot and a sorted list are complete without their modules", async () => {
  const zubra = createZubra({ components: join(here, 'static-components'), clientModules: 'needed' });
  assert.deepEqual([zubra.describe('media-card').client, zubra.describe('sorted-list').client], [[], []]);
  // A mutating .sort() is the browser's, whichever branch the default props take.
  const { request } = await import('@zubra/compiler');
  const mutating = readFileSync(join(here, 'static-components/sorted-list.zb'), 'utf8').replace('items.toSorted(', '[...items].sort(');
  const checked = request({ command: 'check', path: '/s/sorted-list.zb', files: { '/s/sorted-list.zb': mutating }, client: true });
  assert.deepEqual(checked.client, ['`list` is computed in the browser']);
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const body = page.render('media-card', { heading: 'With' }, { media: '<img alt="photo">', default: '<p>Text</p>' })
      + page.render('media-card', { heading: 'Without' }, { default: '<p>Text</p>' })
      + page.render('sorted-list', { items: [2, 9, 4], sorted: true });
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
  });
  const html = await (await fetch(url)).text();
  assert.doesNotMatch(html, /components\/(media-card|sorted-list)\.js/, 'no modules');
  const page = await open(url);
  await page.waitForLoadState('networkidle');
  assert.deepEqual(await page.$$eval('media-card', (cards) => cards.map((card) => [card.querySelector('h3').textContent, !!card.querySelector('.media img')])), [['With', true], ['Without', false]], 'the section only where there is a picture');
  assert.equal(await page.$eval('media-card .media', (media) => getComputedStyle(media).borderTopStyle), 'solid', 'styled from the page head');
  assert.deepEqual(await page.$$eval('sorted-list li', (items) => items.map((item) => item.textContent)), ['9', '4', '2']);
  assert.equal(await page.evaluate(() => customElements.get('media-card') ?? customElements.get('sorted-list')), undefined);
  assert.deepEqual(page.errors, []);
  await page.done();
});

test("clientModules: 'needed' leaves out the modules of components whose server HTML is complete", async () => {
  assert.throws(() => createZubra({ components, clientModules: 'some' }), /clientModules is "all" or "needed"/);
  const zubra = createZubra({ components, clientModules: 'needed' });
  assert.deepEqual(zubra.describe('book-card').client, [], 'shows its props, and nothing else');
  assert.ok(zubra.describe('count-stepper').client.some((reason) => reason.includes('form control')));
  assert.ok(zubra.describe('hello-there').client.includes('imports `@zubra/runtime`'));
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const body = page.render('book-card', { book: { title: 'Dune', price: 999 }, featured: true }) + page.render('count-stepper', { value: 2 });
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
  });
  const html = await (await fetch(url)).text();
  assert.match(html, /import '\/_zubra\/components\/count-stepper\.js';<\/script>/);
  assert.doesNotMatch(html, /components\/book-card\.js/, 'no module for the card');
  const page = await open(url);
  await page.waitForFunction(() => customElements.get('count-stepper'));
  assert.equal(await page.evaluate(() => customElements.get('book-card')), undefined, 'never defined');
  assert.equal(await page.evaluate(() => document.querySelector('book-card').shadowRoot.querySelector('h3').textContent), 'Dune');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('book-card').shadowRoot.querySelector('h3')).marginTop), '0px', 'its styles came with the server HTML');
  assert.deepEqual(page.errors, []);
  await page.done();
  // The default still ships every module.
  const all = createZubra({ components }).page();
  all.render('book-card', { book: { title: 'Dune', price: 999 } });
  assert.match(all.scripts(), /book-card\.js/);
});

test('a rendered component in another\'s slot: both render on the server and both hydrate', async () => {
  const zubra = createZubra({ components });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    // The child is rendered first, with its hydration markers, and handed over as slot HTML.
    const child = page.render('slot-child', { label: 'Inside' });
    const body = page.render('slot-frame', { heading: 'Frame' }, { default: child });
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
  });
  const html = await (await fetch(url)).text();
  assert.match(html, /<h2>Frame<\/h2>/);
  assert.match(html, /<slot-child label="Inside">\s*<\?zb \[\?><p>Inside<\/p><\?zb \]\?>/, 'the child, with its own markers, inside the frame');
  const page = await open(url);
  await page.waitForFunction(() => customElements.get('slot-child') && customElements.get('slot-frame'));
  await page.click('slot-child button');
  await page.waitForFunction(() => document.querySelector('slot-child button').textContent === 'Clicked 1');
  await page.click('slot-frame > section > button');
  await page.waitForFunction(() => document.querySelector('slot-frame div').hidden);
  assert.equal(await page.evaluate(() => document.querySelectorAll('slot-child p').length), 1, 'hydrated in place, not rendered twice');
  assert.deepEqual(page.errors, [], 'both hydrated the server markup');
  await page.done();
});

test('a form control inside a component submits its value before JavaScript, and only its own after', async () => {
  const zubra = createZubra({ components });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    if (req.url.startsWith('/got')) return res.writeHead(200, { 'content-type': 'text/plain' }).end(req.url);
    const page = zubra.page();
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(page.render('order-form'))));
  });
  const html = await (await fetch(url)).text();
  assert.match(html, /<input type="hidden" name="qty" value="3" data-zb-fallback><\/count-stepper>/);
  // Without JavaScript the stand-in submits the rendered value.
  const off = await open(url, { javascript: false });
  await off.click('button[type=submit]');
  await off.waitForURL(/\/got/);
  assert.equal(new URL(off.url()).search, '?qty=3');
  await off.done();
  // With it, the element removes the stand-in and submits its own value, once.
  const on = await open(url);
  await on.waitForFunction(() => customElements.get('count-stepper') && !document.querySelector('[data-zb-fallback]'));
  await on.click('count-stepper >> button.more');
  await on.click('button[type=submit]');
  await on.waitForURL(/\/got/);
  assert.equal(new URL(on.url()).search, '?qty=4');
  assert.deepEqual(on.errors, []);
  await on.done();
});

test('the Express, Fastify and Hono adapters', async () => {
  const { default: express } = await import('express');
  const { zubra: expressZubra } = await import('../src/express.js');
  const app = express();
  app.use(expressZubra({ components }));
  app.get('/', (req, res) => res.send(res.locals.zubra.finish(layout(res.locals.zubra.render('hello-there', { name: 'Express' })))));
  const expressUrl = await listen(app);
  assert.match(await (await fetch(expressUrl)).text(), /Hello Express\.[^]*import '\/_zubra\/components\/hello-there\.js'/);
  assert.match(await (await fetch(`${expressUrl}/_zubra/components/hello-there.js`)).text(), /\$define\(/);

  const { default: Fastify } = await import('fastify');
  const { zubra: fastifyZubra } = await import('../src/fastify.js');
  const fastify = Fastify();
  await fastify.register(fastifyZubra, { components });
  fastify.get('/', (request, reply) => reply.type('text/html').send(request.zubra.finish(layout(request.zubra.render('hello-there', { name: 'Fastify' })))));
  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const fastifyUrl = `http://127.0.0.1:${fastify.server.address().port}`;
  assert.match(await (await fetch(fastifyUrl)).text(), /Hello Fastify\./);
  assert.match(await (await fetch(`${fastifyUrl}/_zubra/runtime/index.js`)).text(), /export/);
  await fastify.close();

  const { Hono } = await import('hono');
  const { zubra: honoZubra } = await import('../src/hono.js');
  const hono = new Hono();
  hono.use(honoZubra({ components }));
  hono.get('/', (c) => c.html(c.get('zubra').finish(layout(c.get('zubra').render('hello-there', { name: 'Hono' })))));
  assert.match(await (await hono.request('/')).text(), /Hello Hono\./);
  const module = await hono.request('/_zubra/components/hello-there.js');
  assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

// What a framework's server renders: the host tags only, props as attributes (or zb-props).
const FRAMEWORK_HTML = layout(`
  <form method="get" action="/sent">
    <count-stepper name="qty" value="3" label="Tickets"></count-stepper>
    <book-card zb-props='{"book":{"title":"Dune","price":1299},"featured":true}'></book-card>
    <hello-there name="light"></hello-there>
    <button>Send</button>
  </form>
  <script type="importmap">{ "imports": { "@zubra/runtime": "/_zubra/runtime/index.js" } }</script>
  <script type="module">import '/_zubra/components/count-stepper.js'; import '/_zubra/components/book-card.js';</script>`);

test('injectShadowRoots: shadow components complete before JavaScript, form values submit, and hydration keeps it', async () => {
  const zubra = createZubra({ components });
  const injected = zubra.injectShadowRoots(FRAMEWORK_HTML);
  assert.match(injected, /<count-stepper name="qty" value="3" label="Tickets"><template shadowrootmode="open">[^]*<output aria-label="Tickets">3<\/output>[^]*<\/template><input type="hidden" name="qty" value="3" data-zb-fallback><\/count-stepper>/);
  assert.match(injected, /<book-card zb-props='[^']*'><template shadowrootmode="open">[^]*<h3>Dune<\/h3>[^]*\$12\.99[^]*<\/template><\/book-card>/);
  assert.match(injected, /<hello-there name="light"><\/hello-there>/, 'light DOM is left alone');
  assert.equal(zubra.injectShadowRoots(injected), injected, 'a second pass changes nothing');
  // `lightDom: true` (3.3): an empty light-DOM host gets its rendered children too, for a
  // framework that leaves nodes it didn't render alone (Solid).
  const withLight = zubra.injectShadowRoots(FRAMEWORK_HTML, { lightDom: true });
  assert.match(withLight, /<hello-there name="light">\s*<p>Hello light\. <\/p>\s*<\/hello-there>/, withLight);
  assert.match(withLight, /<count-stepper name="qty" value="3" label="Tickets"><template shadowrootmode="open">/);
  assert.equal(zubra.injectShadowRoots(withLight, { lightDom: true }), withLight, 'a second pass with lightDom changes nothing');
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    if (req.url.startsWith('/sent')) return res.writeHead(200, { 'content-type': 'text/plain' }).end(req.url);
    res.writeHead(200, { 'content-type': 'text/html' }).end(injected);
  });

  // Without JavaScript: the shadow roots show, and the form submits the stepper's value.
  let page = await open(url, { javascript: false });
  assert.equal(await page.locator('count-stepper output').textContent(), '3');
  assert.equal(await page.locator('book-card h3').textContent(), 'Dune');
  await page.click('text=Send');
  assert.equal(await page.textContent('body'), '/sent?qty=3');
  await page.done();

  // With JavaScript: the elements hydrate their shadow roots (no warnings), the hidden input
  // is gone, and the form submits the element's own value, once.
  page = await open(url);
  await page.waitForFunction(() => customElements.get('count-stepper') && !document.querySelector('[data-zb-fallback]'));
  await page.locator('count-stepper .more').click();
  assert.equal(await page.locator('count-stepper output').textContent(), '4');
  assert.deepEqual(await page.evaluate(() => [...new FormData(document.querySelector('form'))]), [['qty', '4']]);
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('injectShadowRootsStream: the same result as the whole page, however the chunks fall', async () => {
  const zubra = createZubra({ components });
  const html = FRAMEWORK_HTML.replace('<button>Send</button>', '<button>Send → café</button>');
  const whole = zubra.injectShadowRoots(html);
  const bytes = Buffer.from(html);
  for (const size of [1, 3, 7, 64, 4096]) {
    const stream = zubra.injectShadowRootsStream();
    const out = [];
    stream.on('data', (chunk) => out.push(chunk));
    const done = new Promise((resolve) => stream.on('end', resolve));
    for (let at = 0; at < bytes.length; at += size) stream.write(bytes.subarray(at, at + size));
    stream.end();
    await done;
    assert.equal(Buffer.concat(out.map((chunk) => Buffer.from(chunk))).toString(), whole, `chunks of ${size} bytes`);
  }
  // Hosts that already have their shadow root (the React wrapper renders it) get no second one,
  // even when a chunk ends right after the host's start tag.
  assert.equal(zubra.injectShadowRoots(whole), whole);
  const bytesAgain = Buffer.from(whole);
  for (const size of [1, 5, 13, 4096]) {
    const stream = zubra.injectShadowRootsStream();
    const out = [];
    stream.on('data', (chunk) => out.push(chunk));
    const done = new Promise((resolve) => stream.on('end', resolve));
    for (let at = 0; at < bytesAgain.length; at += size) stream.write(bytesAgain.subarray(at, at + size));
    stream.end();
    await done;
    assert.equal(Buffer.concat(out.map((chunk) => Buffer.from(chunk))).toString(), whole, `already rendered, chunks of ${size} bytes`);
  }
});

test('in production, the runtime served is its production build', async () => {
  const body = (zubra) => zubra.fetch(new Request('http://x/_zubra/runtime/element.js')).then((response) => response.text());
  const dev = await body(createZubra({ components: join(here, 'components'), production: false }));
  const prod = await body(createZubra({ components: join(here, 'components'), production: true }));
  assert.match(dev, /__ZUBRA_HOT__/);
  assert.doesNotMatch(prod, /__ZUBRA_HOT__/);
  assert.match(prod, /Generated by scripts\/build-production\.js/);
});

test('devtools: the components are compiled for the Zubra DevTools and the runtime has its hook; off in production unless asked', async () => {
  const get = (zubra, path) => zubra.fetch(new Request(`http://x/_zubra/${path}`)).then((response) => response.text());
  const options = { components: join(here, 'components') };
  const name = [...(await import('node:fs')).readdirSync(options.components)].find((file) => file.endsWith('.zb')).replace(/\.zb$/, '');
  const dev = createZubra({ ...options, production: false });
  const prod = createZubra({ ...options, production: true });
  const shown = createZubra({ ...options, production: true, devtools: true });
  assert.match(await get(dev, `components/${name}.js`), /\bat: \[\d+, \d+\]/);
  assert.match(await get(dev, 'runtime/element.js'), /devhook\.js/);
  assert.doesNotMatch(await get(prod, `components/${name}.js`), /\bat: \[/);
  assert.doesNotMatch(await get(prod, 'runtime/element.js'), /devhook\.js/);
  assert.match(await get(shown, `components/${name}.js`), /\bat: \[\d+, \d+\]/);
  assert.match(await get(shown, 'runtime/element.js'), /devhook\.js/);
});

// Streaming (3.3): a promise prop renders as pending; `page.stream()` sends the page, then each
// resolved region with its value, for the element to hydrate (or to take as a property, if it
// has already started).
test('stream(): the shell first, then the resolved region, hydrated in place; a rejection shows the catch', async () => {
  const zubra = createZubra({ components });
  let release;
  const reviews = () => new Promise((resolve) => { release = () => resolve([{ id: 1, name: 'Ada', stars: 5 }, { id: 2, name: 'Grace', stars: 4 }]); });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const slow = req.url.includes('slow');
    const failing = req.url.includes('fail');
    const body = page.render('review-list', { heading: 'What people said', reviews: failing ? Promise.reject(new Error('no reviews today')) : slow ? reviews() : Promise.resolve([{ id: 1, name: 'Ada', stars: 5 }]) });
    assert.equal(page.pending, true);
    res.writeHead(200, { 'content-type': 'text/html' });
    page.stream(layout(body)).pipe(res);
  });

  // The whole response: the shell with the pending region, then the swap.
  const text = await (await fetch(url)).text();
  assert.match(text, /<review-list data-zb-stream="0" heading="What people said">\s*<h2>What people said<\/h2>\s*<\?start name="zb-0-0"\?><\?zb \[\?\?>\s*<p class="loading">Loading…<\/p>\s*<\?zb \]\?><\?end\?>/);
  // The resolved region alone (its markers included), for the browser's out-of-order streaming.
  assert.match(text, /<template for="zb-0-0"><\?zb \[\?>\s*<ul>[^<]*<\?zb \[\?><\?zb \[\?><li>Ada: 5<\/li><\?zb \]\?><\?zb \]\?><\/ul>\s*<\?zb \]\?><\/template><script>/);
  assert.match(text, /"reviews":\{"value":\[\{"id":1,"name":"Ada","stars":5\}\]\}/);

  // Without JavaScript: a browser with out-of-order streaming (Chromium 150+) puts the resolved
  // region in place itself; elsewhere the pending content stays (the page is still complete).
  let page = await open(url, { javascript: false });
  const native = await page.evaluate(() => !document.querySelector('template[for]'));
  if (native) {
    assert.deepEqual(await page.$$eval('review-list li', (els) => els.map((el) => el.textContent)), ['Ada: 5']);
    assert.equal(await page.locator('review-list .loading').count(), 0);
  } else {
    assert.equal(await page.locator('review-list .loading').count(), 1);
  }
  assert.equal(native, true, 'Chromium streams out of order');
  await page.done();

  // With JavaScript, the fast case: the swap lands before the module runs, so the element
  // hydrates the resolved region in place.
  page = await open(url);
  await page.waitForFunction(() => document.querySelector('review-list')?.matches(':state(hydrated)'));
  assert.deepEqual(await page.$$eval('review-list li', (els) => els.map((el) => el.textContent)), ['Ada: 5']);
  assert.deepEqual(page.errors, []);
  await page.done();

  // The slow case: the element starts on the pending region, then gets the value as a property.
  const slowUrl = `${url}/?slow`;
  const context = await browser.newContext();
  const slowPage = await context.newPage();
  const errors = [];
  slowPage.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  const navigation = slowPage.goto(slowUrl).catch(() => {});
  await slowPage.waitForFunction(() => document.querySelector('review-list')?.matches(':state(hydrated)'), null, { timeout: 15000 });
  assert.equal(await slowPage.locator('review-list .loading').count(), 1, 'pending until the value arrives');
  release();
  await navigation;
  await slowPage.waitForFunction(() => document.querySelectorAll('review-list li').length === 2);
  assert.equal(await slowPage.locator('review-list .loading').count(), 0);
  assert.equal(await slowPage.locator('template[for]').count(), 0, 'the script removes a template the browser had nowhere to put');
  assert.deepEqual(errors, []);
  await context.close();

  // A rejected promise: the value is an error, and the element shows its catch branch.
  page = await open(`${url}/?fail`);
  await page.waitForFunction(() => document.querySelector('review-list .error'));
  assert.equal(await page.textContent('review-list .error'), 'no reviews today');
  await page.done();
});

test('stream(): a streamed value can\'t close the script it travels in (audit Z2)', async () => {
  const zubra = createZubra({ components });
  const hostile = '</script><script>window.pwned = 1</script><!--';
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    const failing = req.url.includes('fail');
    const body = page.render('review-list', { heading: 'Reviews', reviews: failing ? Promise.reject(new Error(hostile)) : Promise.resolve([{ id: 1, name: hostile, stars: 5 }]) });
    res.writeHead(200, { 'content-type': 'text/html' });
    page.stream(layout(body)).pipe(res);
  });
  const text = await (await fetch(url)).text();
  assert.doesNotMatch(text, /<script>window\.pwned/, 'the value is not markup');
  assert.match(text, /\\u003c\/script>\\u003cscript>window\.pwned/, 'it travels escaped');
  for (const query of ['', '?fail']) {
    const page = await open(`${url}/${query}`);
    await page.waitForFunction((failing) => document.querySelector(failing ? 'review-list .error' : 'review-list li'), Boolean(query));
    assert.equal(await page.evaluate(() => window.pwned), undefined, `no script ran ${query}`);
    const shown = await page.textContent(query ? 'review-list .error' : 'review-list li');
    assert.ok(shown.includes('</script><script>window.pwned = 1</script>'), `shown as text ${query}: ${shown}`);
    // A rejection is logged (its message is the error); a value isn't.
    assert.deepEqual(page.errors, query ? [hostile] : []);
    await page.done();
  }
});

test('stream(): the script puts regions in place where the browser doesn\'t (a shadow root, or no out-of-order streaming)', async () => {
  const zubra = createZubra({ components });
  const url = await listen((req, res) => {
    if (zubra.handle(req, res)) return;
    const page = zubra.page();
    // Settled at once: the regions arrive before the module has loaded, so the script swaps them in.
    const reviews = () => Promise.resolve([{ id: 1, name: 'Ada', stars: 5 }]);
    const body = page.render('review-list', { heading: 'Light', reviews: reviews() }) + page.render('review-panel', { reviews: reviews() });
    res.writeHead(200, { 'content-type': 'text/html' });
    // `?comments`: the markup as Firefox and Safari parse it today, where each `<?…>` is a comment.
    const comments = req.url.includes('comments');
    page.stream(layout(body)).on('data', (chunk) => {
      const text = String(chunk);
      res.write(comments ? text.replace(/<\?((?:zb|start|end)\b[^>]*?)>/g, '<!--?$1-->') : text);
    }).on('end', () => res.end());
  });
  for (const query of ['', '?comments']) {
    const page = await open(`${url}/${query}`, { before: `new MutationObserver(() => {
      const hosts = [...document.querySelectorAll('review-list, review-panel')];
      if (hosts.length === 2 && !window.swapped && hosts.every((host) => host.querySelector('li') || host.shadowRoot?.querySelector('li'))) {
        window.swapped = hosts.every((host) => !host.matches(':state(hydrated)'));
      }
    }).observe(document, { childList: true, subtree: true });` });
    await page.waitForFunction(() => document.querySelector('review-list')?.matches(':state(hydrated)')
      && document.querySelector('review-panel')?.matches(':state(hydrated)'));
    const read = () => page.evaluate(() => ({
      light: [...document.querySelectorAll('review-list li')].map((el) => el.textContent),
      shadow: [...document.querySelector('review-panel').shadowRoot.querySelectorAll('li')].map((el) => el.textContent),
      loading: document.querySelectorAll('review-list .loading').length + document.querySelector('review-panel').shadowRoot.querySelectorAll('.loading').length,
      templates: document.querySelectorAll('template[for]').length,
    }));
    await page.waitForFunction(() => document.querySelector('review-panel').shadowRoot.querySelector('li') && document.querySelector('review-list li'));
    assert.deepEqual(await read(), { light: ['Ada: 5'], shadow: ['Ada: 5'], loading: 0, templates: 0 }, query || 'processing instructions');
    assert.equal(await page.evaluate(() => window.swapped), true, 'in place before the elements started');
    assert.deepEqual(page.errors, []);
    await page.done();
  }
});

test("@zubra/sync is served and mapped by itself, when it's installed", async () => {
  // An app of its own: @zubra/sync in its node_modules (linked to this repository's), and a
  // 'use collection' component.
  const app = mkdtempSync(join(tmpdir(), 'zubra-with-sync-'));
  mkdirSync(join(app, 'node_modules', '@zubra'), { recursive: true });
  symlinkSync(join(here, '../../sync'), join(app, 'node_modules', '@zubra', 'sync'), 'dir');
  mkdirSync(join(app, 'components'));
  writeFileSync(join(app, 'components', 'note-card.zb'), "<script>'use collection notes'; let text = ''</script>\n<note-card doc=\"\">{text}</note-card>\n");
  after(() => rmSync(app, { recursive: true, force: true }));
  const zubra = createZubra({ components: join(app, 'components') });
  const page = zubra.page();
  const html = page.finish(`<html><head></head><body>${page.render('note-card', { doc: 'n1' })}</body></html>`);
  assert.match(html, /"@zubra\/sync":"\/_zubra\/sync\/index\.js"/);
  assert.match(html, /"@zubra\/sync\/connect":"\/_zubra\/sync\/connect\.js"/);
  for (const file of ['index.js', 'connect.js']) {
    const response = await zubra.fetch(new Request(`http://localhost/_zubra/sync/${file}`));
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), /javascript/);
  }
  assert.equal((await zubra.fetch(new Request('http://localhost/_zubra/sync/package.json'))).status, 404); // only its modules
});

test("a 'use collection' component without @zubra/sync installed says what to install", () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-no-sync-'));
  try {
    writeFileSync(join(dir, 'note-card.zb'), "<script>'use collection notes'; let text = ''</script>\n<note-card doc=\"\">{text}</note-card>\n");
    const zubra = createZubra({ components: dir });
    const page = zubra.page();
    const body = page.render('note-card', { doc: 'n1' });
    assert.throws(() => page.finish(`<html><head></head><body>${body}</body></html>`), /needs @zubra\/sync\. Install it: npm install @zubra\/sync/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the plain modules a browser module imports are served, never what a server function imports (audit Z1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-z1-'));
  const outside = mkdtempSync(join(tmpdir(), 'zubra-z1-outside-'));
  try {
    writeFileSync(join(dir, 'secret.js'), "export const SECRET = 'sk_live_123';\n");
    writeFileSync(join(dir, 'theme.js'), "import { shade } from './colors/shade.js';\nexport const theme = shade('dark');\n");
    mkdirSync(join(dir, 'colors'));
    writeFileSync(join(dir, 'colors', 'shade.js'), 'export const shade = (name) => `${name}!`;\n');
    writeFileSync(join(dir, 'later.js'), 'export const later = 1;\n');
    writeFileSync(join(dir, 'unused.js'), 'export const unused = 1;\n');
    mkdirSync(join(dir, '.private'));
    writeFileSync(join(dir, '.private', 'keys.js'), "export const key = 'k';\n");
    writeFileSync(join(outside, 'passwd.js'), "export const root = 'x';\n");
    symlinkSync(join(outside, 'passwd.js'), join(dir, 'linked.js'));
    writeFileSync(join(dir, 'order-form.zb'), `<script>
  import { SECRET } from './secret.js'
  import { theme } from './theme.js'
  const load = () => import('./later.js')
  export async function place(form) {
    'use server'
    return { ok: SECRET.length > 0 }
  }
</script>
<order-form>
  <form action={place}><button onclick={load}>Order {theme}</button></form>
</order-form>
`);
    const zubra = createZubra({ components: dir });
    // null: not the server's to answer (the app's own 404).
    const status = async (path) => (await zubra.fetch(new Request(`http://x/_zubra/components/${path}`)))?.status ?? 404;
    const component = await (await zubra.fetch(new Request('http://x/_zubra/components/order-form.js'))).text();
    assert.doesNotMatch(component, /secret\.js|sk_live/, "the browser module doesn't import it");
    assert.equal(await status('secret.js'), 404, "what only a 'use server' function imports stays on the server");
    assert.equal(await status('theme.js'), 200, 'a module the browser imports');
    assert.equal(await status('colors/shade.js'), 200, 'and what that imports');
    assert.equal(await status('later.js'), 200, 'and a dynamic import()');
    assert.equal(await status('unused.js'), 404, 'nothing imports it');
    assert.equal(await status('.private/keys.js'), 404, 'a hidden folder');
    assert.equal(await status('linked.js'), 404, 'a link out of the folder');
    assert.equal(await status('%2e%2e/x.js'), 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a link out of the folder is refused even when a browser module imports it (audit Z1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-z1-'));
  const outside = mkdtempSync(join(tmpdir(), 'zubra-z1-outside-'));
  try {
    writeFileSync(join(outside, 'elsewhere.js'), 'export const x = 1;\n');
    symlinkSync(join(outside, 'elsewhere.js'), join(dir, 'linked.js'));
    writeFileSync(join(dir, 'link-user.zb'), `<script>
  import { x } from './linked.js'
</script>
<link-user><p>{x}</p></link-user>
`);
    const zubra = createZubra({ components: dir });
    assert.match(await (await zubra.fetch(new Request('http://x/_zubra/components/link-user.js'))).text(), /linked\.js/);
    assert.equal((await zubra.fetch(new Request('http://x/_zubra/components/linked.js'))).status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a render that leaves part of the HTML for the browser says so, once per place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-gaps-'));
  try {
    // A list derived through formatted times: only the browser formats them, so it's empty in
    // the HTML.
    writeFileSync(
      join(dir, 'free-times.zb'),
      [
        '<script>',
        "  const label = (at) => new Date(at).toLocaleTimeString('en-US')",
        '  const choices = starts.map((one) => ({ time: one, free: !taken.includes(one), label: label(one) }))',
        '</script>',
        '<free-times starts={[]} taken={[]}>',
        '  <zb-each items={choices} as="one" key={one.time}><button disabled={!one.free}>{one.time}</button></zb-each>',
        '  <p>{starts.length} times</p>',
        '</free-times>',
        '',
      ].join('\n'),
    );
    const warned = [];
    const zubra = createZubra({ components: dir, warn: (message) => warned.push(message) });
    const html = zubra.page().render('free-times', { starts: [0, 900000], taken: [900000] });
    assert.match(html, /<p>2 times<\/p>/, 'the rest renders');
    assert.doesNotMatch(html, /<button/);
    assert.equal(warned.length, 1, warned.join('\n---\n'));
    assert.match(warned[0], /^@zubra\/server: <free-times> leaves part of its HTML for the browser \(empty without JavaScript\)/);
    assert.match(warned[0], /free-times\.zb:6:\d+/);
    assert.match(warned[0], /items=\{choices\}/);
    zubra.page().render('free-times', { starts: [1800000], taken: [] });
    assert.equal(warned.length, 1, 'once per place, not per render');

    const quiet = [];
    createZubra({ components: dir, gaps: 'ignore', warn: (message) => quiet.push(message) }).page().render('free-times', { starts: [0], taken: [] });
    assert.deepEqual(quiet, []);
    assert.throws(() => createZubra({ components: dir, gaps: 'loud' }), /gaps is "warn" or "ignore"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasSlot is answered on the server from the slots it was given, and the element keeps that markup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-has-slot-'));
  try {
    writeFileSync(
      join(dir, 'note-card.zb'),
      [
        '<script>',
        "  import { hasSlot } from '@zubra/runtime'",
        "  const actions = hasSlot('actions')",
        '</script>',
        '<note-card text="">',
        '  <p>{text}</p>',
        '  <div zb-if={actions} class="actions"><zb-slot name="actions"></zb-slot></div>',
        '</note-card>',
        '',
      ].join('\n'),
    );
    const warned = [];
    const zubra = createZubra({ components: dir, warn: (message) => warned.push(message) });
    const url = await listen((req, res) => {
      if (zubra.handle(req, res)) return;
      const page = zubra.page();
      const body = [
        page.render('note-card', { text: 'With' }, { actions: '<a href="#retry">Retry</a>' }),
        page.render('note-card', { text: 'Without' }),
        page.render('note-card', { text: 'Blank' }, { actions: '  ' }),
        // Before the modules run: the server's link, to check the element keeps it.
        '<script>window.serverLink = document.querySelector(\'a[href="#retry"]\')</script>',
      ].join('\n');
      res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
    });
    const html = await (await fetch(url)).text();
    assert.equal(warned.length, 0, warned.join('\n'));
    assert.equal(html.match(/class="actions"/g)?.length, 1, 'the wrapper only where the slot has content');
    assert.match(html, /<div class="actions">[^]*<a href="#retry"[^>]*>Retry<\/a>/);

    const plain = await open(url, { javascript: false });
    assert.equal(await plain.locator('.actions a').count(), 1, 'there without JavaScript');
    await plain.done();

    const page = await open(url);
    await page.waitForFunction(() => customElements.get('note-card'));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('note-card .actions').count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector('note-card .actions a') === window.serverLink), true, 'the same link: hydrated, not rebuilt');
    assert.deepEqual(page.errors, []);
    await page.done();

    // A shadow component: the same, through its declarative shadow root.
    writeFileSync(join(dir, 'note-card.zb'), readFileSync(join(dir, 'note-card.zb'), 'utf8').replace('<note-card text="">', '<note-card shadow text="">'));
    const shadowed = createZubra({ components: dir });
    const shadowUrl = await listen((req, res) => {
      if (shadowed.handle(req, res)) return;
      const page = shadowed.page();
      const body = [page.render('note-card', { text: 'With' }, { actions: '<a href="#retry" slot="actions">Retry</a>' }), page.render('note-card', { text: 'Without' })].join('\n');
      res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
    });
    const shadow = await open(shadowUrl);
    await shadow.waitForFunction(() => customElements.get('note-card'));
    await shadow.waitForTimeout(100);
    assert.deepEqual(await shadow.evaluate(() => [...document.querySelectorAll('note-card')].map((card) => card.shadowRoot.querySelectorAll('.actions').length)), [1, 0]);
    assert.deepEqual(shadow.errors, []);
    await shadow.done();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
