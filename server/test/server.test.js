// @mnx/server: pages for template engines, the adapters, and shadow roots for framework HTML.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMnx } from '../src/index.js';

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
async function open(url, { javascript = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: javascript });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  await page.goto(url);
  page.errors = errors;
  page.done = () => context.close();
  return page;
}
const layout = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

test('a page: render, finish (CSS, import map, modules), and the browser modules served by handle()', async () => {
  const mnx = createMnx({ components });
  assert.deepEqual(mnx.names, ['book-card', 'count-stepper', 'hello-there']);
  assert.equal(mnx.describe('count-stepper').form, true);
  const url = await listen((req, res) => {
    if (mnx.handle(req, res)) return;
    const page = mnx.page();
    const body = page.render('hello-there', { name: 'Ada', items: [{ label: 'a', on: true }, { label: 'b' }, { label: 'c', on: true }] });
    res.writeHead(200, { 'content-type': 'text/html' }).end(page.finish(layout(body)));
  });
  const html = await (await fetch(url)).text();
  assert.match(html, /<p>Hello Ada\. a, c<\/p>/, 'rendered on the server, JavaScript (filter, map, join) included');
  assert.match(html, /<style data-mnx-components>[^]*color: rgb\(0, 128, 0\)/);
  assert.match(html, /"@mnx\/runtime":"\/_mnx\/runtime\/index\.js"/);
  assert.match(html, /import '\/_mnx\/components\/hello-there\.js';<\/script>\n?<\/body>/);
  assert.equal((await fetch(`${url}/_mnx/components/nope.js`)).status, 404);
  // (fetch() would normalize the dots away: send the path as written.)
  const { request } = await import('node:http');
  const body = await new Promise((resolve) => request(`${url}/`, { path: '/_mnx/runtime/../../package.json' }, (response) => {
    let text = '';
    response.on('data', (chunk) => (text += chunk)).on('end', () => resolve(text));
  }).end());
  assert.doesNotMatch(body, /"name": "@mnx\/runtime"/, 'no way out of the runtime folder (the dots resolve first)');
  const page = await open(url);
  await page.waitForFunction(() => document.querySelector('hello-there p').textContent.startsWith('Hello Ada!'));
  assert.deepEqual(page.errors, [], 'it hydrated the server markup');
  await page.done();
});

test('the Express, Fastify and Hono adapters', async () => {
  const { default: express } = await import('express');
  const { mnx: expressMnx } = await import('../src/express.js');
  const app = express();
  app.use(expressMnx({ components }));
  app.get('/', (req, res) => res.send(res.locals.mnx.finish(layout(res.locals.mnx.render('hello-there', { name: 'Express' })))));
  const expressUrl = await listen(app);
  assert.match(await (await fetch(expressUrl)).text(), /Hello Express\.[^]*import '\/_mnx\/components\/hello-there\.js'/);
  assert.match(await (await fetch(`${expressUrl}/_mnx/components/hello-there.js`)).text(), /\$define\(/);

  const { default: Fastify } = await import('fastify');
  const { mnx: fastifyMnx } = await import('../src/fastify.js');
  const fastify = Fastify();
  await fastify.register(fastifyMnx, { components });
  fastify.get('/', (request, reply) => reply.type('text/html').send(request.mnx.finish(layout(request.mnx.render('hello-there', { name: 'Fastify' })))));
  await fastify.listen({ port: 0, host: '127.0.0.1' });
  const fastifyUrl = `http://127.0.0.1:${fastify.server.address().port}`;
  assert.match(await (await fetch(fastifyUrl)).text(), /Hello Fastify\./);
  assert.match(await (await fetch(`${fastifyUrl}/_mnx/runtime/index.js`)).text(), /export/);
  await fastify.close();

  const { Hono } = await import('hono');
  const { mnx: honoMnx } = await import('../src/hono.js');
  const hono = new Hono();
  hono.use(honoMnx({ components }));
  hono.get('/', (c) => c.html(c.get('mnx').finish(layout(c.get('mnx').render('hello-there', { name: 'Hono' })))));
  assert.match(await (await hono.request('/')).text(), /Hello Hono\./);
  const module = await hono.request('/_mnx/components/hello-there.js');
  assert.equal(module.headers.get('content-type'), 'text/javascript; charset=utf-8');
});

// What a framework's server renders: the host tags only, props as attributes (or mnx-props).
const FRAMEWORK_HTML = layout(`
  <form method="get" action="/sent">
    <count-stepper name="qty" value="3" label="Tickets"></count-stepper>
    <book-card mnx-props='{"book":{"title":"Dune","price":1299},"featured":true}'></book-card>
    <hello-there name="light"></hello-there>
    <button>Send</button>
  </form>
  <script type="importmap">{ "imports": { "@mnx/runtime": "/_mnx/runtime/index.js" } }</script>
  <script type="module">import '/_mnx/components/count-stepper.js'; import '/_mnx/components/book-card.js';</script>`);

test('injectShadowRoots: shadow components complete before JavaScript, form values submit, and hydration keeps it', async () => {
  const mnx = createMnx({ components });
  const injected = mnx.injectShadowRoots(FRAMEWORK_HTML);
  assert.match(injected, /<count-stepper name="qty" value="3" label="Tickets"><template shadowrootmode="open">[^]*<output aria-label="Tickets">3<\/output>[^]*<\/template><input type="hidden" name="qty" value="3" data-mnx-fallback><\/count-stepper>/);
  assert.match(injected, /<book-card mnx-props='[^']*'><template shadowrootmode="open">[^]*<h3>Dune<\/h3>[^]*\$12\.99[^]*<\/template><\/book-card>/);
  assert.match(injected, /<hello-there name="light"><\/hello-there>/, 'light DOM is left alone');
  assert.equal(mnx.injectShadowRoots(injected), injected, 'a second pass changes nothing');
  const url = await listen((req, res) => {
    if (mnx.handle(req, res)) return;
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
  await page.waitForFunction(() => customElements.get('count-stepper') && !document.querySelector('[data-mnx-fallback]'));
  await page.locator('count-stepper .more').click();
  assert.equal(await page.locator('count-stepper output').textContent(), '4');
  assert.deepEqual(await page.evaluate(() => [...new FormData(document.querySelector('form'))]), [['qty', '4']]);
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('injectShadowRootsStream: the same result as the whole page, however the chunks fall', async () => {
  const mnx = createMnx({ components });
  const html = FRAMEWORK_HTML.replace('<button>Send</button>', '<button>Send → café</button>');
  const whole = mnx.injectShadowRoots(html);
  const bytes = Buffer.from(html);
  for (const size of [1, 3, 7, 64, 4096]) {
    const stream = mnx.injectShadowRootsStream();
    const out = [];
    stream.on('data', (chunk) => out.push(chunk));
    const done = new Promise((resolve) => stream.on('end', resolve));
    for (let at = 0; at < bytes.length; at += size) stream.write(bytes.subarray(at, at + size));
    stream.end();
    await done;
    assert.equal(Buffer.concat(out.map((chunk) => Buffer.from(chunk))).toString(), whole, `chunks of ${size} bytes`);
  }
});
