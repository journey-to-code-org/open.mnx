// How zb-each puts rows on the page: a row made in the browser is its block's own nodes, with no
// markers around it, and text bindings write the Text node they already have.
// `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, runtimeOnly } from './harness.js';

useBrowser({ 'plain-rows': join(here, 'fixtures/plain-rows.zb') });

const set = (page, props) => page.evaluate(async (props) => {
  const el = document.querySelector('zb-plain-rows');
  Object.assign(el, props);
  await el.updateComplete;
}, props);
const R = (...ids) => ids.map((id) => ({ id, text: { 1: 'milk', 2: 'eggs', 3: 'bread', 4: 'jam' }[id] }));
// Comments in a list's parent: the list's own two markers, and nothing per row.
const comments = (page, selector) => page.$eval(`zb-plain-rows ${selector}`, (parent) =>
  [...parent.childNodes].filter((node) => node.nodeType === Node.COMMENT_NODE).length);

test('rows made in the browser have no markers of their own', { skip: runtimeOnly }, async () => {
  const { page, messages } = await open('<zb-plain-rows></zb-plain-rows>', { modules: ['plain-rows'] });
  assert.equal(await comments(page, 'ul'), 2, 'three rows, and only the list\'s two markers');
  await set(page, { rows: R(3, 4, 1, 2) });
  assert.equal(await comments(page, 'ul'), 2);
  assert.deepEqual(await page.$$eval('zb-plain-rows ul li', (items) => items.map((li) => li.textContent)), ['bread', 'jam', 'milk', 'eggs']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a row whose first node is a region keeps its nodes together through toggles and moves', { skip: runtimeOnly }, async () => {
  const { page, messages } = await open('<zb-plain-rows></zb-plain-rows>', { modules: ['plain-rows'] });
  const order = () => page.$$eval('zb-plain-rows ol > b, zb-plain-rows ol > i', (nodes) => nodes.map((node) => `${node.localName}${node.dataset.id}`));
  assert.deepEqual(await order(), ['b1', 'i1', 'b2', 'i2', 'b3', 'i3']);
  await set(page, { shown: false });
  assert.deepEqual(await order(), ['i1', 'i2', 'i3']);
  await set(page, { rows: R(3, 1, 2) });
  await set(page, { shown: true });
  assert.deepEqual(await order(), ['b3', 'i3', 'b1', 'i1', 'b2', 'i2'], 'each <b> came back in its own row, wherever the row went');
  await set(page, { rows: R(2, 3) });
  assert.deepEqual(await order(), ['b2', 'i2', 'b3', 'i3'], 'a removed row took its region with it');
  assert.deepEqual(messages, []);
  await page.close();
});

test('rows of an empty block can be added, moved and removed', { skip: runtimeOnly }, async () => {
  const { page, messages } = await open('<zb-plain-rows></zb-plain-rows>', { modules: ['plain-rows'] });
  await set(page, { rows: R(3, 2, 1, 4) });
  await set(page, { rows: R(4, 1) });
  await set(page, { rows: [] });
  assert.equal(await page.$eval('zb-plain-rows p', (p) => p.textContent.trim()), '');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a text binding writes the Text node it has, instead of replacing it', { skip: runtimeOnly }, async () => {
  const { page, messages } = await open('<zb-plain-rows></zb-plain-rows>', { modules: ['plain-rows'] });
  await page.evaluate(() => { window.text = document.querySelector('zb-plain-rows li[data-id="2"]').firstChild; });
  await set(page, { rows: [{ id: 1, text: 'milk' }, { id: 2, text: 'eggs (dozen)' }, { id: 3, text: 'bread' }] });
  const result = await page.evaluate(() => {
    const li = document.querySelector('zb-plain-rows li[data-id="2"]');
    return { text: li.textContent, same: li.firstChild === window.text, children: li.childNodes.length };
  });
  assert.deepEqual(result, { text: 'eggs (dozen)', same: true, children: 1 });
  assert.deepEqual(messages, []);
  await page.close();
});
