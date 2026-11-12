// A compiled async fetcher whose props and state are read only after its first `await`: the
// compiler routes them through the run's `track()`, so changing them loads again (ECMAScript
// roadmap E4). `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({ 'await-tracked': join(here, 'fixtures/await-tracked.zb') });

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
