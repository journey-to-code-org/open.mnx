// @zubra/runtime/primitives in Chromium: roving focus and typeahead on plain markup.
// `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useBrowser, open } from './harness.js';

useBrowser({});

const MENU = `<div id="menu" role="menu">
  <button role="menuitem">Apple</button><button role="menuitem">Banana</button>
  <button role="menuitem" disabled>Blackberry</button><button role="menuitem">Blueberry</button>
  <button role="menuitem">Cherry</button>
</div><button id="after">after</button>`;
const setup = (options) => `import { rovingFocus, typeahead } from '/runtime/primitives.js';
const menu = document.getElementById('menu');
window.stops = [rovingFocus(menu, ${options}), typeahead(menu, { selector: '[role=menuitem]' })];
window.moved = [];`;
const focused = (page) => page.evaluate(() => document.activeElement.textContent || document.activeElement.id);

test('rovingFocus: one tab stop, arrows, Home and End, skipping disabled items, looping', async () => {
  const { page, messages } = await open(MENU, { beforeModules: setup("{ selector: '[role=menuitem]', orientation: 'vertical', onMove: (item) => window.moved.push(item.textContent) }") });
  assert.deepEqual(await page.$$eval('[role=menuitem]', (items) => items.map((item) => item.tabIndex)), [0, -1, -1, -1, -1]);
  await page.keyboard.press('Tab');
  assert.equal(await focused(page), 'Apple');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(page), 'Blueberry', 'the disabled item is skipped');
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(page), 'Blueberry', 'vertical: Left and Right do nothing');
  await page.keyboard.press('End');
  assert.equal(await focused(page), 'Cherry');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(page), 'Apple', 'loops');
  await page.keyboard.press('ArrowUp');
  assert.equal(await focused(page), 'Cherry');
  await page.keyboard.press('Home');
  assert.equal(await focused(page), 'Apple');
  assert.deepEqual(await page.evaluate(() => window.moved), ['Banana', 'Blueberry', 'Cherry', 'Apple', 'Cherry', 'Apple']);
  // One tab stop: Tab leaves the group.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  assert.equal(await focused(page), 'after');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await focused(page), 'Banana', 'back to the item that was current');
  // A click makes an item current.
  await page.click('text=Cherry');
  assert.deepEqual(await page.$$eval('[role=menuitem]', (items) => items.map((item) => item.tabIndex)), [-1, -1, -1, -1, 0]);
  assert.deepEqual(messages, []);
});

test('rovingFocus: horizontal, without looping, and right to left', async () => {
  const { page } = await open(`<div dir="rtl">${MENU}</div>`, { beforeModules: setup("{ selector: '[role=menuitem]', orientation: 'horizontal', loop: false }") });
  await page.focus('text=Apple');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await focused(page), 'Banana', 'in RTL, Left is next');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(page), 'Apple', 'no loop: stays on the first');
});

test('typeahead: a prefix jumps, a repeated letter cycles, a pause starts over', async () => {
  const { page } = await open(MENU, { beforeModules: setup("{ selector: '[role=menuitem]', orientation: 'vertical' }") });
  await page.focus('text=Apple');
  await page.keyboard.type('c');
  assert.equal(await focused(page), 'Cherry');
  await page.keyboard.type('b');
  assert.equal(await focused(page), 'Cherry', 'within the pause, "cb" matches nothing');
  await page.waitForTimeout(600);
  await page.keyboard.type('b');
  assert.equal(await focused(page), 'Banana');
  await page.keyboard.type('b');
  assert.equal(await focused(page), 'Blueberry', 'b again cycles (the disabled item is skipped)');
  await page.waitForTimeout(600);
  await page.keyboard.type('bl');
  assert.equal(await focused(page), 'Blueberry');
});

test('the cleanups remove the behaviour', async () => {
  const { page } = await open(MENU, { beforeModules: setup("{ selector: '[role=menuitem]' }") });
  await page.evaluate(() => window.stops.forEach((stop) => stop()));
  await page.focus('text=Apple');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('c');
  assert.equal(await focused(page), 'Apple');
});
