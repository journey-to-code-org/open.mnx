// The built app (react-router-serve) in Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let server, url, browser;

// (react-router-serve prints the port it was given, so find a free one first.)
const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

before(async () => {
  server = spawn(join(root, 'node_modules/.bin/react-router-serve'), ['./build/server/index.js'], { cwd: root, env: { ...process.env, PORT: String(await freePort()) }, stdio: ['ignore', 'pipe', 'inherit'] });
  url = await new Promise((resolve, reject) => {
    server.stdout.on('data', (data) => {
      const port = /localhost:(\d+)/.exec(String(data))?.[1];
      if (port) resolve(`http://localhost:${port}`);
    });
    server.once('exit', (code) => reject(new Error(`react-router-serve exited with ${code}`)));
  });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.kill();
});

async function open({ javascript = true } = {}) {
  await fetch(`${url}/reset`, { method: 'POST' });
  const context = await browser.newContext({ javaScriptEnabled: javascript });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && !/status of 400/.test(message.text()) && errors.push(message.text()));
  await page.goto(url);
  if (javascript) await page.locator('balance-list').getByRole('img', { name: /^Ana:/ }).waitFor();
  page.errors = errors;
  page.done = () => context.close();
  return page;
}
const balance = (page, name) => page.locator('balance-list').getByRole('img', { name: new RegExp(`^${name}:`) }).getAttribute('aria-label');

test('the page hydrates without errors, and the elements get their props from React', async () => {
  const page = await open();
  assert.equal(await balance(page, 'Ana'), 'Ana: $294.87');
  assert.equal(await balance(page, 'Chloé'), 'Chloé: −$153.12');
  assert.equal(await page.locator('segmented-control').getByRole('button', { name: 'food' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('adding an expense with <Form>: the mnx controls submit with it, the balances follow', async () => {
  const page = await open();
  await page.fill('input[name=what]', 'Kayak rental');
  await page.locator('money-input input').fill('90');
  await page.locator('segmented-control').getByRole('button', { name: 'fun' }).click();
  await page.selectOption('select[name=paidBy]', 'Chloé');
  await page.getByRole('checkbox', { name: 'Dev' }).uncheck();
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.expenses li').length === 4);
  assert.match(await page.textContent('.expenses li:last-child'), /Kayak rental fun.*Chloé paid \$90\.00, split 3 ways/);
  assert.equal(await balance(page, 'Chloé'), 'Chloé: −$93.12');
  assert.equal(await page.inputValue('input[name=what]'), '', 'the form was reset');
  // Delete it again, with a fetcher.
  await page.getByRole('button', { name: 'Delete Kayak rental' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.expenses li').length === 3);
  assert.equal(await balance(page, 'Chloé'), 'Chloé: −$153.12');
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('the server\'s validation comes back through the action', async () => {
  const page = await open();
  await page.locator('money-input input').fill('12');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.waitForSelector('.error');
  assert.deepEqual(await page.locator('.error').allTextContents(), ['What was it for?']);
  await page.done();
});

test('without JavaScript the form still posts, but the mnx controls aren\'t in it (they need JavaScript to be form controls)', async () => {
  const page = await open({ javascript: false });
  assert.equal(await page.locator('balance-list li').count(), 0, 'the server HTML has the host only');
  await page.fill('input[name=what]', 'Firewood');
  await page.getByRole('button', { name: 'Add expense' }).click();
  // No amount and no category arrived: the action says so.
  assert.deepEqual(await page.locator('.error').allTextContents(), ['An amount above $0.']);
  await page.done();
});
