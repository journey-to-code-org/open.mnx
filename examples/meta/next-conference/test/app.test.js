// The conference app in Chromium: `npm run build` (the components' library build, then Next's),
// `next start`, and the schedule, filter, stars and feedback form, with no hydration errors.
import { test, before, after } from 'node:test';
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
const port = 4700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
let server, browser;

before(async () => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: root, stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => String(chunk).includes('Ready') && resolve());
    server.on('exit', (code) => reject(new Error(`next start exited with ${code}`)));
  });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.kill();
});

async function open(path) {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(error.message));
  await page.goto(base + path);
  return { page, messages };
}

test('the schedule: server-rendered hosts, the track filter, and stars that survive a reload', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.equal((html.match(/<session-card/g) ?? []).length, 12, 'every card is in the server HTML');
  const { page, messages } = await open('/');
  await page.waitForSelector('session-card article');
  assert.equal(await page.locator('session-card').count(), 12);
  await page.click('segmented-control button[data-value=Design]');
  await page.waitForFunction(() => document.querySelectorAll('session-card').length === 3);
  assert.deepEqual(await page.locator('session-card').evaluateAll((cards) => [...new Set(cards.map((card) => card.track))]), ['Design']);

  await page.click('segmented-control button[data-value=all]');
  await page.click('session-card >> nth=2 >> button');
  await page.click('session-card >> nth=5 >> button');
  await page.waitForFunction(() => document.querySelector('.count').textContent.includes('2 starred'));
  await page.reload();
  await page.click('segmented-control button[data-value=starred]');
  await page.waitForFunction(() => document.querySelectorAll('session-card').length === 2);
  assert.equal(await page.locator('session-card button[aria-pressed=true]').count(), 2);
  assert.deepEqual(messages, [], 'no hydration errors, no runtime warnings');
  await page.close();
});

test('feedback through a Server Action: mnx form controls submit like native inputs, and validate', async () => {
  const { page, messages } = await open('/sessions/s6');
  await page.waitForSelector('star-rating button');
  assert.match(await page.textContent('[data-testid=ratings]'), /No ratings yet/);

  // Required, and empty: the browser stops the submission, as for a native required input.
  await page.click('button:has-text("Send feedback")');
  assert.equal(await page.evaluate(() => document.querySelector('star-rating').validationMessage), 'Pick a rating');
  assert.equal(await page.locator('[role=status]').count(), 0);

  await page.click('star-rating button[aria-label="5 of 5"]');
  await page.click('toggle-switch button');
  await page.fill('textarea[name=comment]', 'Loved the forms demo.');
  await page.click('button:has-text("Send feedback")');
  await page.waitForSelector('[role=status]');
  assert.equal(await page.textContent('[role=status]'), 'Thanks! You rated it 5 of 5.');
  await page.waitForFunction(() => document.querySelector('[data-testid=ratings]').textContent.startsWith('5 ★'));
  assert.equal(await page.textContent('[data-testid=ratings]'), '5 ★ from 1 rating · 1 want a follow-up');
  assert.deepEqual(messages, []);
  await page.close();
});
