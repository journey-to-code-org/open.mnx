// {...spread} onto a zubra component: the entries that are its props are set as props, the
// rest land on its host like on any element, an explicit prop wins, and a key that goes away
// is unset. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({
  badge: join(here, 'fixtures/badge.zb'),
  'spread-onto': join(here, 'fixtures/spread-onto.zb'),
});

const set = (page, rest) => page.evaluate(async (rest) => {
  const el = document.querySelector('spread-onto');
  el.rest = rest;
  await el.updateComplete;
  await Promise.all([...el.querySelectorAll('zb-badge')].map((badge) => badge.updateComplete));
}, rest);
const read = (page) => page.$$eval('spread-onto zb-badge', (badges) => badges.map((badge) => ({
  label: badge.label,
  count: badge.count,
  text: badge.querySelector('.badge b').textContent + '/' + badge.querySelector('.badge i').textContent,
  title: badge.getAttribute('title'),
  classes: [...badge.classList],
  attributes: [...badge.attributes].map((attribute) => attribute.name).filter((name) => !['class', 'title', 'label', 'count'].includes(name)).sort(),
})));

test('props go to the component as props; the other entries go to its host', async () => {
  const { page, messages } = await open('<spread-onto></spread-onto>', { modules: ['badge', 'spread-onto'] });
  await set(page, { label: 'sale', count: 3, info: { color: 'red' }, title: 'hi', 'data-x': '1', class: 'extra' });
  const [first] = await read(page);
  assert.equal(first.label, 'sale');
  assert.equal(first.count, 3, 'a number stays a number: it is a property, not an attribute');
  assert.equal(first.text, 'sale/3');
  assert.equal(await page.$eval('spread-onto zb-badge .badge', (badge) => badge.dataset.color), 'red', 'an object arrives as the object');
  assert.equal(await page.$eval('spread-onto zb-badge', (badge) => badge.hasAttribute('info')), false);
  assert.equal(first.title, 'hi');
  assert.deepEqual(first.classes, ['own', 'extra']);
  assert.ok(first.attributes.includes('data-x'));
  assert.deepEqual(messages, []);
});

test('an explicit prop wins over the spread, however the spread changes', async () => {
  const { page } = await open('<spread-onto></spread-onto>', { modules: ['badge', 'spread-onto'] });
  await set(page, { label: 'sale', count: 3 });
  assert.equal((await read(page))[1].label, 'fixed');
  assert.equal((await read(page))[1].count, 3);
  await set(page, { label: 'other', count: 4 });
  assert.deepEqual((await read(page)).map((badge) => [badge.label, badge.count]), [['other', 4], ['fixed', 4]]);
});

test('a key that goes away is unset', async () => {
  const { page } = await open('<spread-onto></spread-onto>', { modules: ['badge', 'spread-onto'] });
  await set(page, { label: 'sale', count: 3, title: 'hi' });
  await set(page, { count: 5 });
  const [first] = await read(page);
  assert.equal(first.count, 5);
  assert.notEqual(first.label, 'sale', 'the removed prop is no longer set');
  assert.equal(first.title, null, 'the removed attribute is removed');
});
