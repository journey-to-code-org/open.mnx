// Motion (`animate`): a branch going away leaves (`data-leaving`, then removed when its
// transition ends), keyed rows that stay glide to their new places, removed rows leave out of the
// flow, and reduced motion turns all of it off. Runs on both outputs: `ZUBRA_EMIT=element` too.
// `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({ motion: join(here, 'fixtures/motion.zb') });

const set = (page, values) => page.evaluate(async (values) => {
  const el = document.querySelector('zb-motion');
  Object.assign(el, values);
  await el.updateComplete;
}, values);
const count = (page, selector) => page.$$eval(selector, (els) => els.length);
const leaving = (page, selector) => page.$$eval(selector, (els) => els.map((el) => [el.textContent, el.hasAttribute('data-leaving'), el.inert]));
const gone = (page, selector) => page.waitForFunction((selector) => !document.querySelector(selector), selector, { timeout: 3000 });
const rows = [{ id: 1, label: 'one' }, { id: 2, label: 'two' }, { id: 3, label: 'three' }];

test('a leaving branch stays, marked and inert, until its transition ends', async () => {
  const { page, messages } = await open('<zb-motion></zb-motion>', { modules: ['motion'] });
  await set(page, { open: false });
  assert.deepEqual(await leaving(page, '.panel'), [['Panel', true, true]], 'the old branch is still here, leaving');
  assert.deepEqual(await leaving(page, '.closed'), [['Closed', false, false]], 'the new one is in beside it');
  assert.deepEqual(await leaving(page, '.note'), [['Note', true, true]], 'zb-animate beside zb-if does the same');
  const order = await page.$$eval('.panel, .closed', (els) => els.map((el) => el.className));
  assert.deepEqual(order, ['panel', 'closed'], 'it leaves where it was');
  await gone(page, '.panel');
  await gone(page, '.note');
  assert.equal(await count(page, '.closed'), 1);
  // Back again, while nothing is leaving: still one of each.
  await set(page, { open: true });
  await gone(page, '.closed');
  assert.equal(await count(page, '.panel:not([data-leaving])'), 1);
  assert.deepEqual(messages, []);
  await page.close();
});

test('switching quickly leaves each old branch and keeps one live branch', async () => {
  const { page, messages } = await open('<zb-motion></zb-motion>', { modules: ['motion'] });
  await set(page, { tab: 'b' });
  await set(page, { tab: 'a' });
  await set(page, { tab: 'b' });
  assert.deepEqual(await page.$$eval('.tab:not([data-leaving])', (els) => els.map((el) => el.textContent)), ['B']);
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1, null, { timeout: 3000 });
  assert.deepEqual(messages, []);
  await page.close();
});

test('an infinite animation inside does not keep a branch forever', async () => {
  const { page, messages } = await open('<zb-motion></zb-motion>', { modules: ['motion'] });
  await set(page, { spin: true });
  await set(page, { spin: false });
  assert.equal(await count(page, '.spinner'), 0, 'nothing that ends was running, so it went at once');
  assert.deepEqual(messages, []);
  await page.close();
});

test('keyed rows that stay glide; removed rows leave out of the flow', async () => {
  const { page, messages } = await open('<zb-motion></zb-motion>', { modules: ['motion'] });
  await set(page, { items: rows });
  const three = await page.$('li:nth-child(3)');
  await set(page, { items: [rows[2], rows[0]] });
  const moves = await page.evaluate((three) => three.getAnimations().filter((a) => !(a instanceof CSSTransition)).map((a) => a.effect.getKeyframes()[0].transform), three);
  assert.deepEqual(moves, ['translate(0px, 40px)'], 'row three glides up from where it was');
  const two = await page.$$eval('li', (els) => els.filter((el) => el.hasAttribute('data-leaving')).map((el) => [el.textContent, el.style.position]));
  assert.deepEqual(two, [['two', 'absolute']], 'row two leaves, held in place out of the flow');
  assert.deepEqual(await page.$$eval('li:not([data-leaving])', (els) => els.map((el) => el.textContent)), ['three', 'one']);
  await page.waitForFunction(() => document.querySelectorAll('li').length === 2, null, { timeout: 3000 });
  // Rows leaving aren't counted when placing the next change.
  await set(page, { items: [rows[0], rows[2], rows[1]] });
  assert.deepEqual(await page.$$eval('li:not([data-leaving])', (els) => els.map((el) => el.textContent)), ['one', 'three', 'two']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('reduced motion: branches and rows go at once, and nothing glides', async () => {
  const { page, messages } = await open('<zb-motion></zb-motion>', { modules: ['motion'] });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await set(page, { open: false, items: rows });
  assert.equal(await count(page, '.panel'), 0);
  assert.equal(await count(page, '[data-leaving]'), 0);
  const one = await page.$('li');
  await set(page, { items: [rows[2], rows[1]] });
  assert.equal(await count(page, 'li'), 2);
  assert.equal(await page.evaluate((one) => one.isConnected, one), false);
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  assert.deepEqual(messages, []);
  await page.close();
});
