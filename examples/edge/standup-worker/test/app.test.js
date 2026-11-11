// The standup board on a Worker, in workerd, with Chromium: two browser contexts are two teammates.
// Sync's server is a Durable Object and the lead picker's form posts to a 'use server' function,
// so this is @zubra/sync/durable and @zubra/actions/edge working together, end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startWorker } from './wrangler.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const state = mkdtempSync(join(tmpdir(), 'standup-worker-')); // the Durable Object's storage, across restarts
let worker;
let browser;

const start = async () => (worker = await startWorker(root, ['--persist-to', state]));

before(async () => {
  await start();
  browser = await chromium.launch();
}, { timeout: 120_000 });
after(async () => {
  await browser?.close();
  await worker?.stop();
  rmSync(state, { recursive: true, force: true });
});

async function teammate({ javaScriptEnabled = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(worker.url);
  if (javaScriptEnabled) {
    await page.waitForFunction(() => customElements.get('standup-card') && customElements.get('lead-picker'));
    await page.waitForTimeout(300); // documents loaded, live stream open
  }
  return { context, page, errors };
}
const card = (doc) => `standup-card[doc=${doc}]`;
const today = (page, doc, text) =>
  page.waitForFunction(([selector, text]) => document.querySelector(`${selector} textarea`).value === text, [card(doc), text], { timeout: 5000 });
const lead = (page) => page.textContent('lead-picker .lead');

test('the page is complete before JavaScript: the lead picker and every card, from the Worker', async () => {
  const { context, page } = await teammate({ javaScriptEnabled: false });
  assert.equal(await lead(page), 'Nobody is leading yet');
  assert.deepEqual(await page.$$eval('standup-card h2', (headings) => headings.map((h) => h.textContent)), ['Ada', 'Grace', 'Linus']);
  await context.close();
});

test('one teammate types; the other sees it, and sees who is editing, through the Durable Object', async () => {
  const ada = await teammate();
  const grace = await teammate();
  await ada.page.fill(`${card('ada')} textarea`, 'Moving sync to the edge');
  await ada.page.check(`${card('linus')} input[type=checkbox]`);
  await today(grace.page, 'ada', 'Moving sync to the edge');
  await grace.page.waitForSelector(`${card('linus')} article.blocked`, { timeout: 5000 });
  await ada.page.focus(`${card('ada')} textarea`);
  await grace.page.waitForSelector(`${card('ada')} .presence`, { timeout: 5000 });
  assert.equal(await grace.page.$(`${card('grace')} .presence`), null);
  assert.deepEqual([...ada.errors, ...grace.errors], []);
  // Ada leaves the page mid-edit: it says it's leaving (pagehide), and Grace stops seeing her.
  await ada.page.goto('about:blank');
  await grace.page.waitForSelector(`${card('ada')} .presence`, { state: 'detached', timeout: 1500 });
  await ada.context.close();
  await grace.context.close();
});

test("two people press \"Lead today\" at once: the object decides, one leads, and every board shows who", async () => {
  const ada = await teammate();
  const grace = await teammate();
  await ada.page.fill('lead-picker input[name=name]', 'Ada');
  await grace.page.fill('lead-picker input[name=name]', 'Grace');
  await Promise.all([ada.page.click('lead-picker button'), grace.page.click('lead-picker button')]);
  const shown = (page) => page.waitForFunction(() => /is leading today$/.test(document.querySelector('lead-picker .lead').textContent), null, { timeout: 5000 });
  await Promise.all([shown(ada.page), shown(grace.page)]);
  const [a, g] = [await lead(ada.page), await lead(grace.page)];
  assert.equal(a, g, 'both boards show the same lead');
  const winner = a.startsWith('Ada') ? ada : grace;
  const loser = winner === ada ? grace : ada;
  await loser.page.waitForSelector('lead-picker .message', { timeout: 5000 });
  assert.equal(await loser.page.textContent('lead-picker .message'), a);
  assert.equal(await winner.page.$('lead-picker .message'), null);
  assert.equal(new URL(winner.page.url()).pathname, '/', 'the enhanced post stays on the page');
  assert.deepEqual([...ada.errors, ...grace.errors], []);
  await ada.context.close();
  await grace.context.close();
});

test('without JavaScript, the form still posts, and the answer comes back on the page', async () => {
  const linus = await teammate({ javaScriptEnabled: false });
  const current = await lead(linus.page);
  await linus.page.fill('lead-picker input[name=name]', 'Linus');
  await Promise.all([linus.page.waitForNavigation(), linus.page.click('lead-picker button')]);
  assert.equal(await lead(linus.page), current);
  assert.equal(await linus.page.textContent('lead-picker .message'), current, 'refused: someone leads already');
  await linus.page.reload();
  assert.equal(await linus.page.$('lead-picker .message'), null, 'the answer is shown once');
  await linus.context.close();
});

test("the log is the object's SQLite: after the Worker restarts, a new device gets everything", { timeout: 120_000 }, async () => {
  const before = (await (await fetch(`${worker.url}/_zb/sync/pull?since=0`)).json()).cursor;
  await worker.stop();
  await start();
  assert.equal((await (await fetch(`${worker.url}/_zb/sync/pull?since=0`)).json()).cursor, before);
  const newcomer = await teammate();
  await today(newcomer.page, 'ada', 'Moving sync to the edge');
  assert.match(await lead(newcomer.page), /^(Ada|Grace) is leading today$/);
  await newcomer.context.close();
});
