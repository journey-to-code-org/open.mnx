// 4.1's conditions without wrappers, in the browser: zb-if as an attribute and markup in braces
// switch branches, hydrate server markup in place, and keyed rows keep their elements.
// `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, compiler, runtimeOnly } from './harness.js';

const fixture = join(here, 'fixtures/conditions.zb');
useBrowser({ conditions: fixture });

const set = (page, values) => page.evaluate(async (values) => {
  const el = document.querySelector('zb-conditions');
  Object.assign(el, values);
  await el.updateComplete;
}, values);
const text = (page, selector) => page.$$eval(selector, (els) => els.map((el) => el.textContent));

test('attribute conditions and markup in braces switch as their state changes', async () => {
  const { page, messages } = await open('<zb-conditions></zb-conditions>', { modules: ['conditions'] });
  assert.deepEqual(await text(page, '.count'), ['Nothing yet.']);
  assert.deepEqual(await text(page, '.cell'), []);
  assert.deepEqual(await text(page, '.who'), ['Sign in']);
  await set(page, { count: 3, user: { name: 'Ada' } });
  assert.deepEqual(await text(page, '.count'), ['A few.']);
  assert.deepEqual(await text(page, '.cell'), ['3']);
  assert.deepEqual(await text(page, '.who'), ['Ada']);
  assert.deepEqual(await text(page, '.lots'), ['lots']);
  await set(page, { count: 9 });
  assert.deepEqual(await text(page, '.count'), ['Many.']);
  await set(page, { items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  const first = await page.$('li');
  await set(page, { items: [{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }] });
  assert.deepEqual(await text(page, 'li'), ['B', 'A']);
  assert.equal(await page.evaluate((el) => el.textContent, first), 'A', 'the keyed row moved with its element');
  assert.equal(await page.evaluate((el) => el === document.querySelectorAll('li')[1], first), true);
  await page.click('li >> nth=0');
  assert.deepEqual(await text(page, '.count'), ['Nothing yet.'], 'a handler in a row closes over its index');
  assert.deepEqual(messages, []);
  await page.close();
});

test('server markup with both forms hydrates in place', { skip: runtimeOnly }, async () => {
  const html = compiler(fixture, '--emit', 'html');
  const { page, messages } = await open(html, {
    beforeModules: "window.kept = [...document.querySelectorAll('zb-conditions *')];",
    modules: ['conditions'],
  });
  await set(page, {});
  assert.equal(await page.evaluate(() => window.kept.every((node) => node.isConnected)), true);
  await set(page, { count: 1 });
  assert.deepEqual(await text(page, '.count'), ['A few.']);
  assert.deepEqual(messages, []);
  await page.close();
});
