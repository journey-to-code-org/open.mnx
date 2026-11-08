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
  // Timed from the element's start, not the page's: a slow browser can take longer than the
  // delay to load the modules.
  const { page, messages } = await open('<script>window.wait = 300</script><zb-loader></zb-loader>', {
    modules: ['loader'],
    beforeModules: `customElements.whenDefined('zb-loader').then(() => { window.started = performance.now(); });
      new MutationObserver(() => { if (!window.pendingAt && document.querySelector('.pending')) window.pendingAt = performance.now(); })
        .observe(document, { childList: true, subtree: true });`,
  });
  await page.waitForSelector('.pending');
  assert.deepEqual(await shown(page), ['Loading…'], 'the pending block after the delay');
  const waited = await page.evaluate(() => window.pendingAt - window.started);
  assert.ok(waited >= 90, `nothing before the delay (the pending block came after ${Math.round(waited)} ms)`);
  await page.waitForSelector('.done');
  assert.deepEqual(await shown(page), ['Ada: 2']);
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
