// The standup board in Chromium: two browser contexts are two teammates' devices.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.js';

const dir = mkdtempSync(join(tmpdir(), 'standup-'));
const db = join(dir, 'standup.db');
let server;
let base;
let browser;

const start = async () => {
  server = await createApp({ db, cache: false });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
};
const stop = () => new Promise((done) => {
  server.closeAllConnections?.();
  server.close(done);
});

before(async () => {
  await start();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

async function teammate() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => customElements.get('standup-card'));
  await page.waitForTimeout(200); // documents loaded, live stream open
  return { context, page, errors };
}
const card = (doc) => `standup-card[doc=${doc}]`;
const today = (page, doc, text) =>
  page.waitForFunction(([selector, text]) => document.querySelector(`${selector} textarea`).value === text, [card(doc), text], { timeout: 5000 });

test('the page is complete before JavaScript: every card, server-rendered', async () => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(base);
  assert.deepEqual(await page.$$eval('standup-card h2', (headings) => headings.map((h) => h.textContent)), ['Ada', 'Grace', 'Linus']);
  await context.close();
});

test('one teammate types; the other sees it, and sees who is editing', async () => {
  const ada = await teammate();
  const grace = await teammate();
  await ada.page.fill(`${card('ada')} textarea`, 'Shipping the sync example');
  await ada.page.check(`${card('linus')} input[type=checkbox]`);
  await today(grace.page, 'ada', 'Shipping the sync example');
  await grace.page.waitForSelector(`${card('linus')} article.blocked`, { timeout: 5000 });
  // Ada is still in her card's textarea: Grace sees that someone is editing it, and only it.
  await ada.page.focus(`${card('ada')} textarea`);
  await grace.page.waitForSelector(`${card('ada')} .presence`, { timeout: 5000 });
  assert.equal(await grace.page.$(`${card('grace')} .presence`), null);
  await ada.page.focus(`${card('grace')} textarea`);
  await grace.page.waitForSelector(`${card('ada')} .presence`, { state: 'detached', timeout: 5000 });
  assert.deepEqual([...ada.errors, ...grace.errors], []);
  await ada.context.close();
  await grace.context.close();
});

test('offline, edits keep working and reach the team once back', async () => {
  const ada = await teammate();
  const grace = await teammate();
  await ada.context.setOffline(true);
  await ada.page.fill(`${card('grace')} textarea`, 'Written on the train');
  await ada.page.waitForTimeout(300);
  assert.equal(await grace.page.inputValue(`${card('grace')} textarea`), '');
  await ada.context.setOffline(false);
  await today(grace.page, 'grace', 'Written on the train');
  await ada.context.close();
  await grace.context.close();
});

test('the log is a SQLite file: after a restart, a new device gets everything', async () => {
  await stop();
  await start();
  const newcomer = await teammate();
  await today(newcomer.page, 'ada', 'Shipping the sync example');
  await today(newcomer.page, 'grace', 'Written on the train');
  await newcomer.context.close();
});
