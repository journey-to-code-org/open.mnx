// The whole loop in a browser: the same form, with JavaScript (fetch, no navigation, the
// component's `onaction` handler) and without it (a real post, 303 back, the result rendered by
// the server from the one-use cookie).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createZubra } from '@zubra/server';
import { createActions } from '../src/index.js';

const components = fileURLToPath(new URL('./components', import.meta.url));
let browser;
let server;
let base;

before(async () => {
  const zubra = createZubra({ components, cache: false });
  const actions = await createActions({ components });
  server = createServer(async (req, res) => {
    if (await actions.handle(req, res)) return;
    if (zubra.handle(req, res)) return;
    const done = actions.result(req, (name, value) => res.setHeader(name, value));
    const page = zubra.page();
    const outcome = done ? `<output id="outcome">${JSON.stringify(done.value)}</output>` : '';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page.finish(`<!doctype html><html><head></head><body>${outcome}${page.render('login-form')}${actions.script()}</body></html>`));
  });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('with JavaScript: fetch, no navigation, the result reaches the component', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/login`);
  await page.waitForFunction(() => customElements.get('login-form'));
  let navigated = false;
  page.on('framenavigated', () => (navigated = true));
  await page.fill('input[name=email]', 'a@example.com');
  await page.click('button[type=submit]');
  await page.waitForSelector('.message:has-text("Welcome a@example.com")');
  assert.equal(navigated, false);
  await page.fill('input[name=email]', 'b@example.com');
  await page.click('button[type=submit]');
  await page.waitForSelector('.message:has-text("Invalid login")');
  assert.equal(await page.getAttribute('form', 'aria-busy'), null);
  assert.deepEqual(errors, []);
  await page.close();
});

test('without JavaScript: a real post, back to the page, the server renders the result once', async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.fill('input[name=email]', 'b@example.com');
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/login`);
  assert.equal(await page.textContent('#outcome'), '{"error":"Invalid login"}');
  await page.reload();
  assert.equal(await page.$('#outcome'), null);
  await context.close();
});
