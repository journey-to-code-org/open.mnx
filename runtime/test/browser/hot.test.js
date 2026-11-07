// Hot reloads in development: a new version of a component is swapped into the live elements,
// keeping their props, state and slotted content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, production } from './harness.js';

const skip = production && 'the production build has no hot reloading';

useBrowser({
  'hot-v1': join(here, 'fixtures/hot/v1.mnx'),
  'hot-v2': join(here, 'fixtures/hot/v2.mnx'),
  'hot-v3': join(here, 'fixtures/hot/v3.mnx'),
  'hot-shadow-v1': join(here, 'fixtures/hot/shadow-v1.mnx'),
  'hot-shadow-v2': join(here, 'fixtures/hot/shadow-v2.mnx'),
});

test('a new version of a component keeps its state, props and slotted content', { skip }, async () => {
  const { page, messages } = await open('<hot-box label="B"><b>given</b></hot-box>', {
    beforeModules: 'globalThis.__MNX_HOT__ = true;',
    modules: ['hot-v1'],
  });
  const read = () => page.evaluate(async () => {
    const el = document.querySelector('hot-box');
    await el.updateComplete;
    const p = el.querySelector('p');
    return { button: el.querySelector('button').textContent, p: p.className, slotted: p.textContent, same: p.querySelector('b') === window.given, color: getComputedStyle(p).color };
  });
  await page.evaluate(() => { window.given = document.querySelector('b'); });
  await page.click('button');
  await page.click('button');
  assert.deepEqual(await read(), { button: 'B: 2', p: '', slotted: 'given', same: true, color: 'rgb(255, 0, 0)' });

  const reloaded = await page.evaluate(async () => (await import('/hot-v2.js')).default.hotReloaded);
  assert.equal(reloaded, true);
  assert.deepEqual(await read(), { button: 'B = 2 (new)', p: 'v2', slotted: 'given', same: true, color: 'rgb(0, 0, 255)' });
  await page.click('button');
  assert.equal((await read()).button, 'B = 12 (new)');
  // The content stays live: a framework's later change still reaches the slot.
  await page.evaluate(() => document.querySelector('hot-box').append('!'));
  assert.equal((await read()).slotted, 'given!');

  // A changed interface (a new prop) can't be swapped in: the page needs a full reload.
  assert.equal(await page.evaluate(async () => (await import('/hot-v3.js')).default.hotReloaded), false);
  assert.equal((await read()).button, 'B = 12 (new)');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a shadow-DOM component reloads in its shadow root', { skip }, async () => {
  const { page, messages } = await open('<hot-shadow label="S"><b>given</b></hot-shadow>', {
    beforeModules: 'globalThis.__MNX_HOT__ = true;',
    modules: ['hot-shadow-v1'],
  });
  const read = () => page.evaluate(async () => {
    const el = document.querySelector('hot-shadow');
    await el.updateComplete;
    const p = el.shadowRoot.querySelector('p');
    return { button: el.shadowRoot.querySelector('button').textContent, color: getComputedStyle(p).color, sheets: el.shadowRoot.adoptedStyleSheets.length };
  });
  await page.click('hot-shadow button');
  const before = await read();
  assert.deepEqual({ ...before, sheets: undefined }, { button: 'S: 1', color: 'rgb(255, 0, 0)', sheets: undefined });
  assert.equal(await page.evaluate(async () => (await import('/hot-shadow-v2.js')).default.hotReloaded), true);
  assert.deepEqual(await read(), { button: 'S = 1 (new)', color: 'rgb(0, 0, 255)', sheets: before.sheets });
  assert.deepEqual(messages, []);
  await page.close();
});

test('without hot module replacement, a second definition is ignored', { skip }, async () => {
  const { page, messages } = await open('<hot-box></hot-box>', { modules: ['hot-v1', 'hot-v2'] });
  assert.equal(await page.textContent('hot-box button'), 'A: 0');
  assert.deepEqual(messages, []);
  await page.close();
});
