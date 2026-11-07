// The app in a real browser: builds it, serves the build and clicks the counter.
// `npm test` (needs Chromium for Playwright: `npx playwright install chromium`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildApp } from './build.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

test('the counter counts, and the app sees its count', async () => {
  const dist = await buildApp(root);
  const server = createServer((request, response) => {
    let path = join(dist, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    try {
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain' }).end(readFileSync(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('hello-counter button.more');
    assert.equal(await page.textContent('hello-counter output'), 'Clicks: 0');
    assert.equal(await page.isDisabled('hello-counter button.less'), true);

    await page.click('hello-counter button.more');
    await page.click('hello-counter button.more');
    await page.waitForFunction(() => document.querySelector('#seen')?.textContent === '2');
    assert.equal(await page.textContent('hello-counter output'), 'Clicks: 2');
    await page.click('hello-counter button.less');
    await page.waitForFunction(() => document.querySelector('#seen')?.textContent === '1');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
