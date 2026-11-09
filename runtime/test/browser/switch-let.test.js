// 4.3's let: and zb-switch in the browser: a let: value follows what it reads, and a switch
// follows its value. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, compiler, runtimeOnly } from './harness.js';

const fixture = join(here, 'fixtures/switch-let.zb');
useBrowser({ 'switch-let': fixture });

const set = (page, values) => page.evaluate(async (values) => {
  const el = document.querySelector('zb-switch-let');
  Object.assign(el, values);
  await el.updateComplete;
}, values);
const rows = (page) => page.$$eval('li', (els) => els.map((el) => `${el.textContent}${el.classList.contains('big') ? ' big' : ''}`));

test('let: values follow their row; zb-switch follows its value', async () => {
  const { page, messages } = await open('<zb-switch-let></zb-switch-let>', { modules: ['switch-let'] });
  assert.equal(await page.textContent('.status'), 'Waiting');
  await set(page, { cart: [{ id: 1, price: 3, qty: 2 }, { id: 2, price: 5, qty: 1 }], status: 'paid' });
  assert.deepEqual(await rows(page), ['1: 6 big', '2: 5']);
  assert.equal(await page.textContent('.status'), 'Paid');
  await set(page, { cart: [{ id: 1, price: 3, qty: 2 }, { id: 2, price: 5, qty: 3 }] });
  assert.deepEqual(await rows(page), ['1: 6 big', '2: 15 big']);
  await set(page, { status: 'delivered' });
  assert.equal(await page.textContent('.status'), 'On its way');
  await set(page, { status: 'lost' });
  assert.equal(await page.textContent('.status'), 'Waiting');
  assert.deepEqual(messages, []);
  await page.close();
});

test('server markup with let: and zb-switch hydrates in place', { skip: runtimeOnly }, async () => {
  const props = JSON.stringify({ cart: [{ id: 1, price: 3, qty: 2 }], status: 'shipped' });
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'zb-switch-')), 'props.json');
  writeFileSync(file, props);
  const html = compiler(fixture, '--props', file);
  assert.match(html, /<li class="big">1: 6<\/li>/);
  assert.match(html, /On its way/);
  const { page, messages } = await open(html, {
    beforeModules: "window.kept = [...document.querySelectorAll('zb-switch-let *')];",
    modules: ['switch-let'],
  });
  await set(page, {});
  assert.equal(await page.evaluate(() => window.kept.every((node) => node.isConnected)), true);
  await set(page, { status: 'paid' });
  assert.equal(await page.textContent('.status'), 'Paid');
  assert.deepEqual(messages, []);
  await page.close();
});
