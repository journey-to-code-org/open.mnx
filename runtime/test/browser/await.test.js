// resource() and <mnx-await> in the browser: pending, resolved and failed states, replacing an
// in-flight request, and hydrating the server's pending markup. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, compiler } from './harness.js';

const fixture = join(here, 'fixtures/await.mnx');
useBrowser({ await: fixture, 'await-static': join(here, 'fixtures/await-static.mnx') });

// The page decides when each request answers.
const LOADER = `
  window.requests = [];
  window.loadUser = (who, signal) => new Promise((resolve, reject) => {
    window.requests.push({ who, resolve, reject, signal });
  });
`;

const read = (page) => page.evaluate(async () => {
  const el = document.querySelector('mnx-await-demo');
  await new Promise((resolve) => setTimeout(resolve));
  await el.updateComplete;
  const text = (selector) => el.querySelector(selector)?.textContent ?? null;
  return { pending: text('.pending'), name: text('.name'), error: text('.error'), plain: text('b'), status: text('.status') };
});

test('pending, then resolved; a newer request replaces one in flight; errors show mnx-catch', async () => {
  const { page, messages } = await open('<mnx-await-demo></mnx-await-demo>', { modules: ['await'], beforeModules: LOADER });
  assert.deepEqual(await read(page), { pending: 'Loading ada…', name: null, error: null, plain: '7', status: 'pending' });

  await page.evaluate(() => window.requests[0].resolve({ name: 'Ada Lovelace' }));
  assert.deepEqual(await read(page), { pending: null, name: 'Ada Lovelace', error: null, plain: '7', status: 'ready' });

  // A new prop re-runs the fetcher; the first answer to arrive late is ignored.
  await page.evaluate(() => { document.querySelector('mnx-await-demo').who = 'linus'; });
  await read(page);
  await page.evaluate(() => { document.querySelector('mnx-await-demo').who = 'grace'; });
  assert.equal((await read(page)).pending, 'Loading grace…');
  assert.equal(await page.evaluate(() => window.requests[1].signal.aborted), true, 'the replaced request was aborted');
  await page.evaluate(() => { window.requests[2].resolve({ name: 'Grace Hopper' }); window.requests[1].resolve({ name: 'Linus' }); });
  assert.equal((await read(page)).name, 'Grace Hopper');

  await page.evaluate(() => { document.querySelector('mnx-await-demo').who = 'nobody'; });
  await read(page);
  await page.evaluate(() => window.requests[3].reject(new Error('not found')));
  assert.deepEqual(await read(page), { pending: null, name: null, error: 'not found', plain: '7', status: 'error' });

  await page.evaluate(() => document.querySelector('mnx-await-demo').remove());
  await page.evaluate(() => { document.body.append(document.createElement('mnx-await-demo')); });
  await read(page);
  assert.deepEqual(messages, []);
  await page.close();
});

test('the server renders the pending content, and the element takes over from it', async () => {
  // The HTML output renders each mnx-await's pending content; the element binds to it, then
  // shows the settled block.
  const html = compiler(join(here, 'fixtures/await-static.mnx'));
  assert.match(html, /<!--\[--><span>…<\/span><!--\]-->/);
  const { page, messages } = await open(html, { modules: ['await-static'] });
  await page.waitForFunction(() => document.querySelector('mnx-await-static i'));
  assert.equal(await page.$eval('mnx-await-static', (el) => el.querySelector('i').textContent), '42');
  assert.deepEqual(messages, []);
  await page.close();
});
