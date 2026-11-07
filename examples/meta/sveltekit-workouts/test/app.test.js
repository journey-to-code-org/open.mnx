// The workout log in Chromium: `vite build` with adapter-node, the server, then the stats and
// list (mnx elements Svelte uses directly) and the form action, enhanced with use:enhance, whose
// inputs are mnx form controls.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Inside this repository: the CLI from `cargo build`, unless mnx.wasm is built (see README).
const cli = join(root, '../../../target/debug', process.platform === 'win32' ? 'mnx.exe' : 'mnx');
if (!process.env.MNX_COMPILER && existsSync(cli)) process.env.MNX_COMPILER = cli;
const port = 5100 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
let server, browser;

before(async () => {
  // The origin is part of the build: the server checks form posts against it.
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'pipe', env: { ...process.env, ORIGIN: base } });
  server = spawn(process.execPath, [join(root, 'build')], { cwd: root, stdio: 'pipe', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' } });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => String(chunk).includes('Listening') && resolve());
    server.on('exit', (code) => reject(new Error(`the server exited with ${code}`)));
  });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.kill();
});
beforeEach(() => fetch(`${base}/reset`, { method: 'POST' }));

async function open(path) {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(error.message));
  await page.goto(base + path);
  return { page, messages };
}

test('the stats and the list: mnx elements with Svelte props, including an object prop', async () => {
  const { page, messages } = await open('/');
  await page.waitForSelector('workout-row .row');
  assert.equal(await page.locator('workout-row').count(), 8);
  assert.equal(await page.getByRole('img', { name: 'Effort 4 of 5' }).count() >= 1, true);
  // The streak grid's `log` is an object: Svelte's server HTML says "[object Object]", then it
  // sets the real object. No warning, and the grid shows the logged days.
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<streak-grid log="\[object Object\]"/);
  assert.ok(await page.locator('streak-grid button[aria-pressed=true]').count() >= 6);
  assert.match(await page.getByRole('img', { name: /^Days trained this week: \d+%$/ }).getAttribute('aria-label'), /%$/);
  assert.deepEqual(messages, []);
  await page.close();
});

test('logging a workout: a form action, enhanced, with mnx form controls submitting like inputs', async () => {
  const { page, messages } = await open('/');
  await page.waitForSelector('quantity-stepper[name=sets] button.more');
  await page.selectOption('select[name=exercise]', 'row');
  await page.click('quantity-stepper[name=sets] button.more');
  await page.click('quantity-stepper[name=reps] button.less');
  // Effort is required: without it, the browser stops the submission.
  await page.click('button:has-text("Log it")');
  assert.equal(await page.evaluate(() => document.querySelector('star-rating').validationMessage), 'Pick a rating');
  await page.click('star-rating button[aria-label="5 of 5"]');
  assert.deepEqual(await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('form.log')))), { exercise: 'row', sets: '4', reps: '7', effort: '5' });
  await page.click('button:has-text("Log it")');
  await page.waitForSelector('[role=status]');
  assert.equal(await page.textContent('[role=status]'), 'Logged: row, 4 × 7.');
  await page.waitForFunction(() => document.querySelectorAll('workout-row').length === 9);
  assert.deepEqual(await page.locator('workout-row >> nth=0').evaluate((row) => [row.exercise, row.sets, row.reps, row.effort]), ['row', 4, 7, 5]);
  assert.deepEqual(messages, []);
  await page.close();
});

test('the action validates on the server', async () => {
  const response = await fetch(`${base}/?/log`, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'exercise=row&sets=40' });
  const result = await response.json();
  assert.equal(result.type, 'failure');
  assert.equal(result.status, 400);
  assert.match(result.data, /Sets: 1 to 10/);
});
