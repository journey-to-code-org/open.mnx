// JSX components (`.zb.jsx` / `.zb.tsx`), compiled by the Rust CLI and run in Chromium: props,
// state from `let`, derived `const`s, events from `on…` props, lists, conditionals, slots, and
// components from both formats used together. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({
  badge: join(here, 'fixtures/badge.zb'),
  rating: join(here, 'fixtures/jsx/rating.zb.jsx'),
  panel: join(here, 'fixtures/jsx/panel.zb.tsx'),
});

const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve));
  await Promise.all([...document.querySelectorAll('zb-rating, zb-panel, zb-badge')].map((el) => el.updateComplete));
});

test('a JSX component: props, state, derived values, events, lists and conditionals', async () => {
  const { page, messages } = await open('<zb-rating label="Stars"></zb-rating>', { modules: ['rating'] });
  const read = () => page.evaluate(() => {
    const el = document.querySelector('zb-rating');
    return {
      label: el.querySelector('.label').textContent,
      classes: [...el.querySelectorAll('button')].map((button) => button.className),
      output: el.querySelector('output').textContent,
      great: !!el.querySelector('em'),
    };
  });
  assert.deepEqual(await read(), { label: 'Stars', classes: ['off', 'off'], output: '0', great: false });
  assert.deepEqual(await page.evaluate(() => customElements.get('zb-rating').zubra.events), ['valuechange', 'change']);

  await page.evaluate(() => {
    window.log = [];
    const el = document.querySelector('zb-rating');
    el.addEventListener('valuechange', (event) => window.log.push(['valuechange', event.detail]));
    el.addEventListener('change', (event) => window.log.push(['change', event.detail]));
  });
  await page.hover('zb-rating button:nth-of-type(2)');
  await settle(page);
  assert.deepEqual((await read()).classes, ['on', 'on'], 'state set by a handler; the derived value followed');
  assert.equal((await read()).output, '2');
  await page.mouse.move(0, 0);
  await settle(page);
  assert.deepEqual(await read(), { label: 'Stars', classes: ['off', 'off'], output: '0', great: false });

  await page.click('zb-rating button:nth-of-type(2)');
  await page.mouse.move(0, 0);
  await settle(page);
  assert.deepEqual(await page.evaluate(() => window.log), [['valuechange', 2], ['change', null]], 'onValueChange(2) fired valuechange');
  assert.deepEqual(await read(), { label: 'Stars', classes: ['on', 'on'], output: '2', great: true }, 'assigning the prop updated it');
  assert.equal(await page.evaluate(() => document.querySelector('zb-rating').value), 2);

  await page.evaluate(() => { document.querySelector('zb-rating').value = 1; });
  await settle(page);
  assert.deepEqual(await read(), { label: 'Stars', classes: ['on', 'off'], output: '1', great: false }, 'setting the prop from outside');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a TSX component using an .zb and a JSX component, with slots', async () => {
  const body = '<zb-panel><button slot="actions">Act</button><span class="mine">mine</span></zb-panel>';
  const { page, messages } = await open(body, { modules: ['badge', 'rating', 'panel'] });
  await settle(page);
  const read = () => page.evaluate(() => {
    const el = document.querySelector('zb-panel');
    return {
      heading: el.querySelector('h2').textContent,
      actions: el.querySelector('header').textContent.trim(),
      badges: [...el.querySelectorAll('li')].map((li) => [li.dataset.index, li.querySelector('zb-badge b').textContent, li.querySelector('zb-badge i').textContent]),
      closed: !!el.querySelector('.closed'),
      summary: el.querySelector('.summary').textContent,
      stars: el.querySelector('zb-rating output').textContent,
      footer: el.querySelector('footer').innerHTML.replace(/<!--.*?-->/g, ''),
    };
  });
  assert.deepEqual(await read(), {
    heading: 'People', actions: 'PeopleAct', badges: [['0', 'Ada', '2'], ['1', 'Linus', '0']], closed: false,
    summary: '2 unread, 0 clicks', stars: '2', footer: '<span class="mine">mine</span>',
  });

  await page.evaluate(() => document.querySelector('zb-panel').addEventListener('toggle', (event) => { window.toggled = event.detail; }));
  await page.click('zb-panel h2');
  await settle(page);
  assert.equal(await page.evaluate(() => window.toggled), false);
  const closed = await read();
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.badges, []);
  assert.equal(closed.summary, '2 unread, 1 clicks', 'a let updated by ++ in a handler');

  await page.evaluate(() => { document.querySelector('zb-panel').items = [{ id: 3, name: 'Grace', unread: 1 }]; document.querySelector('zb-panel').open = true; });
  await settle(page);
  const updated = await read();
  assert.deepEqual(updated.badges, [['0', 'Grace', '1']]);
  assert.equal(updated.summary, '1 unread, 1 clicks', 'a derived const recomputed from the new prop');
  assert.equal(updated.stars, '1', 'and the child got the new value');
  assert.deepEqual(messages, []);
  await page.close();
});
