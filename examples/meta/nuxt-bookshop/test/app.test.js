// The bookshop in Chromium: `nuxt build`, the Nitro server, then the list (filtered on the
// server through a zubra segmented control) and the editor (four zubra controls on v-model).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { shot } from '../../../../demos/shot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Inside this repository: the CLI from `cargo build`, unless zubra.wasm is built (see README).
const cli = join(root, '../../../target/debug', process.platform === 'win32' ? 'zubra.exe' : 'zubra');
if (!process.env.ZUBRA_COMPILER && existsSync(cli)) process.env.ZUBRA_COMPILER = cli;
let base; // where the server says it listens
let server, browser;

/** A port nothing is listening on (the OS picks it), so two runs can't collide. */
const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

before(async () => {
  execFileSync(process.execPath, [join(root, 'node_modules/nuxt/bin/nuxt.mjs'), 'build'], { cwd: root, stdio: 'pipe' });
  const port = await freePort();
  server = spawn(process.execPath, [join(root, '.output/server/index.mjs')], { cwd: root, stdio: 'pipe', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' } });
  let output = '';
  base = await new Promise((resolve, reject) => {
    server.stderr.on('data', (chunk) => (output += chunk));
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const url = /Listening on:?\s*(https?:\/\/\S+)/.exec(output)?.[1];
      if (url) resolve(url.replace(/\/$/, '').replace('[::]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1'));
    });
    server.on('exit', (code) => reject(new Error(`the server exited with ${code}:\n${output}`)));
  });
  // Then until it answers: the line can come a moment before the socket takes connections.
  for (let tries = 0; ; tries++) {
    try {
      await fetch(`${base}/api/reset`, { method: 'POST' });
      break;
    } catch (error) {
      if (tries === 50) throw new Error(`the server said ${base} but doesn't answer there:\n${output}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.kill();
});
beforeEach(() => fetch(`${base}/api/reset`, { method: 'POST' }));

async function open(path) {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(error.message));
  await page.goto(base + path);
  return { page, messages };
}

test('the list: server-rendered, filtered by genre through v-model on a zubra element', async () => {
  const { page, messages } = await open('/');
  await page.waitForSelector('stock-meter [role=meter]');
  assert.equal(await page.locator('.books li').count(), 7);
  await shot(page, 'nuxt-bookshop');
  assert.equal(await page.textContent('li[data-id=b4] stock-meter span'), 'Out of stock');
  assert.equal(await page.textContent('li[data-id=b2] stock-meter span'), '2 left: reorder');

  await page.click('segmented-control button[data-value=kids]');
  await page.waitForFunction(() => document.querySelectorAll('.books li').length === 2);
  assert.match(page.url(), /\?genre=kids$/);
  // A shareable URL: loaded directly, the server filters.
  const direct = await open('/?genre=nonfiction');
  await direct.page.waitForSelector('segmented-control button[aria-pressed=true]');
  assert.equal(await direct.page.locator('.books li').count(), 2);
  assert.equal(await direct.page.getAttribute('segmented-control button[aria-pressed=true]', 'data-value'), 'nonfiction');
  assert.deepEqual([...messages, ...direct.messages], [], 'no hydration mismatches');
  await page.close();
  await direct.page.close();
});

test('without JavaScript: the stock meters (light DOM) and the genre switch (a declarative shadow root) are in the server HTML', async () => {
  const html = await (await fetch(`${base}/`)).text();
  // The stock meter is a light-DOM component: the Vue wrapper wrote its props and its rendered
  // children (3.3); the segmented control is shadow DOM, filled by @zubra/server's injectShadowRoots.
  assert.match(html, /<stock-meter zb-props="[^"]*">\s*<div role="meter"/, 'the Vue wrapper wrote zb-props and the light-DOM content');
  assert.match(html, /<segmented-control zb-props="[^"]*"><template shadowrootmode="open">/, 'the shadow root');
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  assert.equal(await page.textContent('li[data-id=b4] stock-meter span'), 'Out of stock');
  assert.equal(await page.textContent('li[data-id=b2] stock-meter span'), '2 left: reorder');
  assert.equal(await page.locator('segmented-control button').count() >= 3, true);
  await context.close();
});

test('editing: money, stock, tags and featured on v-model, saved through the API', async () => {
  const { page, messages } = await open('/books/b2');
  await page.waitForSelector('quantity-stepper button.more');
  assert.equal(await page.isDisabled('button:has-text("Save")'), true, 'nothing changed yet');
  await page.click('quantity-stepper button.more');
  await page.click('quantity-stepper button.more');
  assert.equal(await page.textContent('.stock stock-meter span'), '4 left: reorder', 'the meter follows the stepper');
  await page.click('quantity-stepper button.more');
  assert.equal(await page.textContent('.stock stock-meter span'), '5 in stock');
  await page.fill('money-input input', '23.5');
  await page.locator('money-input input').blur();
  assert.equal(await page.inputValue('money-input input'), '23.50');
  await page.fill('tag-input input', 'Staff Pick');
  await page.press('tag-input input', 'Enter');
  await page.click('toggle-switch button');
  await page.click('button:has-text("Save")');
  await page.waitForSelector('[role=status]');

  const saved = await (await fetch(`${base}/api/books/b2`)).json();
  assert.deepEqual({ price: saved.price, stock: saved.stock, tags: saved.tags, featured: saved.featured }, { price: 23.5, stock: 5, tags: ['historical', 'staff-pick'], featured: true });
  await page.reload();
  await page.waitForSelector('tag-input .tag');
  assert.deepEqual(await page.locator('tag-input .tag').evaluateAll((tags) => tags.map((tag) => tag.textContent.replace('×', '').trim())), ['historical', 'staff-pick']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('the API validates what the editor sends', async () => {
  const response = await fetch(`${base}/api/books/b1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: -1, stock: 1.5, tags: [], featured: false }) });
  assert.equal(response.status, 422);
  assert.deepEqual((await response.json()).data, { price: 'A price between 0 and 1,000.', stock: 'Stock is a whole number from 0 to 999.' });
});
