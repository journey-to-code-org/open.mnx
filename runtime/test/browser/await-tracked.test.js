// A compiled async fetcher whose props and state are read only after its first `await`: the
// compiler routes them through the run's `track()`, so changing them loads again (ECMAScript
// roadmap E4). `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({
  'await-tracked': join(here, 'fixtures/await-tracked.zb'),
  'await-tracked-more': join(here, 'fixtures/await-tracked-more.zb'),
  'await-tracked-jsx': join(here, 'fixtures/await-tracked.zb.jsx'),
});

const SETUP = `
  window.calls = [];
  window.auth = () => new Promise((resolve) => setTimeout(() => resolve('t'), 5));
`;

const value = (page) => page.$eval('zb-await-tracked .value', (p) => p.textContent);

test('state and a prop read after an await load again when they change', async () => {
  const { page, messages } = await open('<zb-await-tracked></zb-await-tracked>', { modules: ['await-tracked'], beforeModules: SETUP });
  await page.waitForFunction(() => document.querySelector('zb-await-tracked .value')?.textContent === 'acme:1:t');

  await page.click('zb-await-tracked button');
  await page.waitForFunction(() => document.querySelector('zb-await-tracked .value').textContent === 'acme:2:t');

  await page.evaluate(() => { document.querySelector('zb-await-tracked').org = 'beta'; });
  await page.waitForFunction(() => document.querySelector('zb-await-tracked .value').textContent === 'beta:2:t');

  assert.equal(await value(page), 'beta:2:t');
  assert.deepEqual(await page.evaluate(() => window.calls), ['acme/1', 'acme/2', 'beta/2']);
  assert.deepEqual(messages, []);
  await page.close();
});

test("a signal's explicit .get() after an await, and a fetcher that isn't async, load again", async () => {
  const { page, messages } = await open('<zb-await-tracked-more></zb-await-tracked-more>', { modules: ['await-tracked-more'], beforeModules: SETUP });
  const text = (selector) => page.$eval(`zb-await-tracked-more ${selector}`, (p) => p.textContent);
  const until = (selector, expected) => page.waitForFunction(([s, e]) =>
    document.querySelector(`zb-await-tracked-more ${s}`)?.textContent === e, [selector, expected]);
  await until('.priced', '1:t');
  await until('.listed', '1:t');

  await page.click('zb-await-tracked-more .rate');
  await until('.priced', '2:t');
  await page.click('zb-await-tracked-more .page');
  await until('.listed', '2:t');

  assert.deepEqual([await text('.priced'), await text('.listed')], ['2:t', '2:t']);
  // Each change ran only its own fetcher again.
  assert.deepEqual((await page.evaluate(() => window.calls)).toSorted(), ['listed 1', 'listed 2', 'priced 1', 'priced 2']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a JSX component reads after an await the same way', async () => {
  const { page, messages } = await open('<zb-await-tracked-jsx></zb-await-tracked-jsx>', { modules: ['await-tracked-jsx'], beforeModules: SETUP });
  const until = (expected) => page.waitForFunction((e) =>
    document.querySelector('zb-await-tracked-jsx .value')?.textContent === e, expected);
  await until('acme:1:t');
  await page.click('zb-await-tracked-jsx button');
  await until('acme:2:t');
  await page.evaluate(() => { document.querySelector('zb-await-tracked-jsx').org = 'beta'; });
  await until('beta:2:t');
  assert.deepEqual(await page.evaluate(() => window.calls), ['acme/1', 'acme/2', 'beta/2']);
  assert.deepEqual(messages, []);
  await page.close();
});
