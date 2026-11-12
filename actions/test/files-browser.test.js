// A file input in a real browser: with JavaScript the enhancing script posts the form's
// FormData, file included; without it, the browser's own multipart post. A file over the limit
// comes back as the action's error on both paths.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createZubra } from '@zubra/server';
import { createActions } from '../src/index.js';

const components = fileURLToPath(new URL('./files', import.meta.url));
let browser;
let server;
let base;
const png = (size) => ({ name: 'barn.png', mimeType: 'image/png', buffer: Buffer.alloc(size, 7) });

before(async () => {
  const zubra = createZubra({ components, cache: false });
  const actions = await createActions({ components, maxBytes: 64 * 1024 });
  server = createServer(async (req, res) => {
    if (await actions.handle(req, res)) return;
    if (zubra.handle(req, res)) return;
    const done = actions.result(req, (name, value) => res.setHeader(name, value));
    const page = zubra.page();
    const outcome = done ? `<output id="outcome">${JSON.stringify(done.value)}</output>` : '';
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(page.finish(`<!doctype html><html><head></head><body>${outcome}${page.render('photo-form')}${actions.script()}</body></html>`));
  });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('with JavaScript: the file reaches the action, and one over the limit is refused', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/listing`);
  await page.waitForFunction(() => customElements.get('photo-form'));
  await page.setInputFiles('input[name=photo]', png(2048));
  await page.click('button[type=submit]');
  await page.waitForSelector('.message:has-text("barn.png 2048")');
  await page.setInputFiles('input[name=photo]', png(100 * 1024));
  await page.click('button[type=submit]');
  await page.waitForSelector('.message:has-text("Too large")');
  assert.deepEqual(errors, []);
  await page.close();
});

test('without JavaScript: the browser posts the file, and the page shows the result', async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${base}/listing`);
  await page.fill('input[name=caption]', 'Red barn');
  await page.setInputFiles('input[name=photo]', png(3000));
  await page.click('button[type=submit]');
  await page.waitForSelector('#outcome');
  const value = JSON.parse(await page.textContent('#outcome'));
  assert.deepEqual(value, { name: 'barn.png', type: 'image/png', size: 3000, first: 7, caption: 'Red barn' });
  await page.setInputFiles('input[name=photo]', png(100 * 1024));
  await page.click('button[type=submit]');
  await page.waitForSelector('#outcome:has-text("Too large")');
  await context.close();
});
