// The built app (Nitro's Node server) in Chromium, with JavaScript on and off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let server, url, browser;
const freePort = () => new Promise((resolve) => {
  const probe = createServer().listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

before(async () => {
  const port = await freePort();
  server = spawn(process.execPath, ['.output/server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'inherit' });
  url = `http://localhost:${port}`;
  for (let tries = 0; tries < 100; tries++) {
    if (await fetch(url).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  await page.goto(url);
  if (javascript) await page.locator('dish-board').getByRole('meter', { name: /^Mains/ }).waitFor();
  page.errors = errors;
  page.done = () => context.close();
  return page;
}
const meter = (page, course) => page.locator('dish-board').getByRole('meter', { name: new RegExp(`^${course}`) }).getAttribute('aria-label');

test('the page hydrates without errors; the board gets its data from Solid (prop:)', async () => {
  const page = await open();
  assert.equal(await meter(page, 'Mains'), 'Mains: 1 of 3');
  assert.equal(await meter(page, 'Desserts'), 'Desserts: 1 of 2');
  assert.equal((await page.locator('dish-board li[data-course=dessert] ul li').textContent()).trim(), 'Ines +2');
  assert.equal((await page.textContent('.lede')).trim(), '3 households, 6 people so far.');
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('signing up: the zubra controls submit with the action\'s form, and the board updates in place', async () => {
  const page = await open();
  await page.fill('input[name=name]', 'Theo');
  await page.fill('input[name=dish]', 'Lemonade');
  await page.locator('choice-cards').getByRole('radio', { name: /Drinks/ }).click();
  await page.locator('quantity-stepper').getByRole('button', { name: /increase|more|\+/i }).click();
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.locator('.notice').waitFor();
  assert.equal((await page.textContent('.notice')).trim(), 'Thanks, Theo! See you Saturday.');
  await page.waitForFunction(() => document.querySelector('.lede').textContent.trim() === '4 households, 8 people so far.');
  assert.equal(await meter(page, 'Drinks'), 'Drinks: 1 of 2');
  // The action's validation: the same name again.
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.locator('.error').waitFor();
  assert.deepEqual(await page.locator('.error').allTextContents(), ['Theo has already signed up.']);
  assert.deepEqual(page.errors, []);
  await page.done();
});

test('without JavaScript: the board is in the server HTML, and signing up posts the controls\' values', async () => {
  const page = await open({ javascript: false });
  // The shadow roots came with the page (src/middleware.js runs it through @zubra/server).
  assert.equal(await meter(page, 'Mains'), 'Mains: 1 of 3');
  assert.equal((await page.locator('dish-board li[data-course=dessert] ul li').textContent()).trim(), 'Ines +2');
  await page.fill('input[name=name]', 'Uma');
  await page.fill('input[name=dish]', 'Slaw');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForLoadState();
  // The course and guest count went with the form, as hidden inputs (Sides, 1 person).
  await page.goto(url);
  assert.equal((await page.textContent('.lede')).trim(), '4 households, 7 people so far.');
  assert.equal((await page.locator('dish-board li[data-course=side] ul li').allTextContents()).join('|'), 'Omar|Uma');
  await page.done();
});
