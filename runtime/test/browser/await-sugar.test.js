// 4.2's zb-await in the browser: a named pending block, an array value waited for together,
// destructured results and errors, retry(), delay and keep. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({ loader: join(here, 'fixtures/await-sugar.zb') });

const shown = (page) => page.evaluate(() => [...document.querySelectorAll('.pending, .done, .error')].map((el) => el.textContent));
const loading = (page) => page.evaluate(() => document.querySelector('zb-loader').matches(':state(loading)'));

test('delay hides a quick wait; an array of a resource and a promise resolves together, destructured', async () => {
  // Recorded in the page, timed from the element's start: a slow browser can take longer than
  // the delay to load the modules, or than the pending block shows to answer a query.
  const { page, messages } = await open('<script>window.wait = 300</script><zb-loader></zb-loader>', {
    modules: ['loader'],
    beforeModules: `customElements.whenDefined('zb-loader').then(() => { window.started = performance.now(); });
      window.seen = [];
      new MutationObserver(() => {
        const text = [...document.querySelectorAll('.pending, .done')].map((el) => el.textContent).join();
        if (text && text !== window.seen.at(-1)?.text) window.seen.push({ text, at: performance.now() - window.started });
      }).observe(document, { childList: true, subtree: true, characterData: true });`,
  });
  await page.waitForSelector('.done');
  assert.deepEqual(await shown(page), ['Ada: 2']);
  const seen = await page.evaluate(() => window.seen);
  assert.deepEqual(seen.map((step) => step.text), ['Loading…', 'Ada: 2'], 'the pending block, then the result');
  assert.ok(seen[0].at >= 90, `nothing before the delay (the pending block came after ${Math.round(seen[0].at)} ms)`);
  assert.equal(await page.textContent('.short'), 'Ada', '<zb-await {user}> is value={user}');
  assert.deepEqual(messages, []);
  await page.close();
});

test('keep holds the content through a reload, with :state(loading); retry() runs the value again', async () => {
  const { page, messages } = await open('<script>window.wait = 0</script><zb-loader></zb-loader>', { modules: ['loader'] });
  await page.waitForSelector('.done');
  await page.evaluate(() => { window.wait = 300; });
  await page.click('.reload');
  await page.waitForTimeout(150);
  assert.deepEqual(await shown(page), ['Ada: 2'], 'kept while reloading, past the delay');
  assert.equal(await loading(page), true);
  await page.waitForFunction(() => !document.querySelector('zb-loader').matches(':state(loading)'));
  assert.deepEqual(await shown(page), ['Ada: 2']);
  assert.equal(await page.evaluate(() => window.calls), 1, 'a resource reloading doesn\'t call posts() again');

  await page.evaluate(() => { window.wait = 0; window.failNext = true; });
  await page.click('.reload');
  await page.waitForSelector('.error');
  assert.deepEqual(await shown(page), ['down'], 'an error replaces the kept content; `as` destructures it');
  assert.equal(await loading(page), false);
  const before = Number(await page.textContent('.attempts'));
  await page.click('.retry');
  await page.waitForSelector('.done');
  assert.deepEqual(await shown(page), ['Ada: 2']);
  assert.equal(Number(await page.textContent('.attempts')), before + 1, 'retry() refreshed the resource');
  assert.equal(await page.evaluate(() => window.calls), 2, 'and evaluated the value again');
  assert.deepEqual(messages, []);
  await page.close();
});
