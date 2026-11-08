// The workout log in Chromium: `vite build` with adapter-node, the server, then the stats and
// list (zubra elements Svelte uses directly) and the form action, enhanced with use:enhance, whose
// inputs are zubra form controls.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { shot } from '../../../../demos/shot.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Inside this repository: the CLI from `cargo build`, unless zubra.wasm is built (see README).
const cli = join(root, '../../../target/debug', process.platform === 'win32' ? 'zubra.exe' : 'zubra');
if (!process.env.ZUBRA_COMPILER && existsSync(cli)) process.env.ZUBRA_COMPILER = cli;
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
beforeEach(() => fetch(`${base}/reset`, { method: 'POST', headers: { origin: base } }));

async function open(path, { javascript = true } = {}) {
  const page = await (await browser.newContext({ javaScriptEnabled: javascript })).newPage();
  const messages = [];
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(error.message));
  await page.goto(base + path);
  return { page, messages };
}

test('the stats and the list: zubra elements with Svelte props, including an object prop', async () => {
  const { page, messages } = await open('/');
  await page.waitForSelector('workout-row .row');
  assert.equal(await page.locator('workout-row').count(), 8);
  await shot(page, 'sveltekit-workouts');
  assert.equal(await page.getByRole('img', { name: 'Effort 4 of 5' }).count() >= 1, true);
  // The streak grid's `log` is an object: Svelte's server HTML says "[object Object]", so the zubra
  // plugin adds zb-props to the host in the server build, which the element starts with. No
  // warning, and the grid shows the logged days.
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<streak-grid zb-props="\{&quot;log&quot;:\{&quot;20\d\d-[^"]*" log="\[object Object\]"/);
  assert.ok(await page.locator('streak-grid button[aria-pressed=true]').count() >= 6);
  assert.match(await page.getByRole('img', { name: /^Days trained this week: \d+%$/ }).getAttribute('aria-label'), /%$/);
  assert.deepEqual(messages, []);
  await page.close();
});

test('logging a workout: a form action, enhanced, with zubra form controls submitting like inputs', async () => {
  const { page, messages } = await open('/');
  // Live, not just drawn: the server's markup has the buttons before their listeners are bound.
  await page.waitForSelector('quantity-stepper[name=sets]:state(hydrated)');
  await page.waitForSelector('quantity-stepper[name=reps]:state(hydrated)');
  await page.waitForSelector('star-rating:state(hydrated)');
  await page.selectOption('select[name=exercise]', 'row');
  await page.click('quantity-stepper[name=sets] button.more');
  await page.click('quantity-stepper[name=reps] button.less');
  // The hidden inputs the server added for these controls are gone: their own values submit.
  assert.equal(await page.locator('[data-zb-fallback]').count(), 0);
  assert.equal(await page.evaluate(() => new FormData(document.querySelector('form.log')).get('effort')), '3');
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

test('without JavaScript: the stats, the list and the form are in the server HTML, and logging a workout works', async () => {
  await fetch(`${base}/reset`, { method: 'POST', headers: { origin: base } });
  const { page, messages } = await open('/', { javascript: false });
  // The shadow roots came with the HTML (@zubra/server in hooks.server.js).
  assert.equal(await page.locator('workout-row').count(), 8);
  assert.equal(await page.locator('workout-row .row').count(), 8, 'each row shows, from its declarative shadow root');
  assert.match(await page.getByRole('img', { name: /^Days trained this week: \d+%$/ }).getAttribute('aria-label'), /%$/, 'the stats');
  // (The streak grid works with dates, Date and Intl, which only the browser computes: it
  // fills in once JavaScript runs.)
  assert.equal(await page.locator('quantity-stepper[name=sets] output').textContent(), '3');
  await page.selectOption('select[name=exercise]', 'row');
  await page.click('button:has-text("Log it")');
  // A plain form post: the controls' server-rendered values went with it.
  assert.equal((await page.textContent('[role=status]')).trim(), 'Logged: row, 3 × 8.');
  assert.equal(await page.locator('workout-row').count(), 9);
  assert.deepEqual(messages, []);
  await page.close();
});
