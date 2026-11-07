// Solid: mnx elements in fine-grained JSX, with prop: and on: bindings that update on every tick
// (prices, arrays of points, selection), nested mnx elements (a tile's spark line), an SVG
// chart with pointer events, and For lists adding and removing elements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('solid-markets: a live dashboard built from mnx elements', async () => {
  const { page, messages } = await launch('solid-markets');
  await page.waitForSelector('price-tile article');
  await page.click('button.toggle'); // pause, so the test steps the market itself
  await settle(page);
  assert.match(await page.textContent('.status'), /^Paused · tick \d+$/);
  const go = async (selector) => { await page.click(selector); await settle(page); };
  const tile = (symbol) => `price-tile[data-symbol=${symbol}]`;
  const price = (symbol) => page.$eval(tile(symbol), (el) => el.price);

  assert.deepEqual(await texts(page, 'price-tile .symbol'), ['NOVA', 'KELP', 'ARCH', 'VOLT']);
  assert.equal(await page.getAttribute(`${tile('NOVA')} article`, 'aria-pressed'), 'true');
  // Each tick sets new props: the price text, the change and the nested spark line follow.
  const before = await page.$eval(tile('NOVA'), (el) => [el.price, el.points.length, el.querySelector('polyline').getAttribute('points')]);
  await go('button.step');
  const after = await page.$eval(tile('NOVA'), (el) => [el.price, el.points.length, el.querySelector('polyline').getAttribute('points'), el.querySelector('.price').textContent]);
  assert.notEqual(after[2], before[2], 'the spark line redrew');
  assert.equal(after[1], Math.min(60, before[1] + 1));
  assert.equal(after[3], after[0].toFixed(2));
  assert.equal(await page.textContent('.big'), `$${after[0].toFixed(2)}`, 'the detail follows the selected symbol');
  const open = await page.$eval(tile('NOVA'), (el) => el.open);
  const change = ((after[0] - open) / open) * 100;
  assert.equal((await page.textContent(`${tile('NOVA')} .change`)).replace('−', '-').replace('+', ''), `${change < 0 ? '-' : ''}${Math.abs(change).toFixed(2)}%`);

  // Selecting another tile (click, then keyboard).
  await go(`${tile('KELP')} article`);
  assert.equal(await page.textContent('.detail h2'), 'KELP');
  assert.equal(await page.getAttribute(`${tile('NOVA')} article`, 'aria-pressed'), 'false');
  await page.focus(`${tile('ARCH')} article`);
  await page.keyboard.press('Enter');
  await settle(page);
  assert.equal(await page.textContent('.detail h2'), 'ARCH');

  // The chart: hovering shows the point under the pointer, from the element's pointhover event.
  const box = await page.locator('line-chart svg').boundingBox();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await settle(page);
  const archPoints = await page.$eval(tile('ARCH'), (el) => el.points);
  assert.equal(await page.textContent('line-chart .tip'), archPoints.at(-1).toFixed(2));
  assert.equal(await page.textContent('.hover'), `0 ticks ago: $${archPoints.at(-1).toFixed(2)}`);
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await settle(page);
  assert.equal(await page.textContent('line-chart .tip'), archPoints[0].toFixed(2));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 80);
  await settle(page);
  assert.equal(await page.$('line-chart .tip'), null);
  assert.match(await page.textContent('.hover'), /^Last \d+ ticks$/);

  // Watchlist: remove a tile (the selected one), add another.
  await page.hover(`${tile('ARCH')} article`);
  await go(`${tile('ARCH')} .remove`);
  assert.deepEqual(await texts(page, 'price-tile .symbol'), ['NOVA', 'KELP', 'VOLT']);
  assert.equal(await page.textContent('.detail h2'), 'NOVA');
  await page.selectOption('select[aria-label="Add a symbol"]', 'MESA');
  await settle(page);
  assert.deepEqual(await texts(page, 'price-tile .symbol'), ['NOVA', 'KELP', 'VOLT', 'MESA']);

  // An alert that the next tick will cross fires once, as a toast.
  const nova = await price('NOVA');
  await page.selectOption('select[aria-label=Direction]', 'below');
  await page.fill('input[aria-label="Alert price"]', String(nova + 100));
  await go('.alert-form button');
  assert.deepEqual(await texts(page, '.alerts li'), [`NOVA below $${(nova + 100).toFixed(2)} · watching`]);
  await go('button.step');
  assert.match(await page.textContent('.toast span'), new RegExp(`^NOVA is below \\$${(nova + 100).toFixed(2).replace('.', '\\.')} \\(now \\$`));
  assert.match(await page.textContent('.alerts li'), /· triggered$/);
  await go('button.step');
  assert.equal(await page.locator('.toast').count(), 1, 'it fires once');
  await go('.toast button');
  assert.equal(await page.locator('.toast').count(), 0);

  // Portfolio: values follow the prices; buying averages the cost.
  const value = async (symbol) => Number((await page.textContent(`tr[data-symbol=${symbol}] .value`)).replace(/[$,]/g, ''));
  assert.equal(await value('NOVA'), Math.round((await price('NOVA')) * 10 * 100) / 100);
  await page.selectOption('.buy select', 'NOVA');
  await page.fill('.buy input', '5');
  await go('.buy button');
  assert.equal(await page.textContent('tr[data-symbol=NOVA] td:nth-child(2)'), '15');
  await page.selectOption('.buy select', 'KELP');
  await page.fill('.buy input', '20');
  await go('.buy button');
  assert.deepEqual(await texts(page, 'tbody td:first-child'), ['NOVA', 'VOLT', 'KELP']);
  assert.equal(await page.textContent('tr[data-symbol=KELP] .gain'), '+$0.00', 'bought at the market price');
  await go('button.step');
  const kelp = await price('KELP');
  assert.equal(await value('KELP'), Math.round(kelp * 20 * 100) / 100);

  // Live again, fast: ticks keep coming and the tiles keep up.
  await page.selectOption('select[aria-label=Speed]', '10');
  const ticks = Number((await page.textContent('.status')).match(/tick (\d+)/)[1]);
  await go('button.toggle');
  await page.waitForTimeout(700);
  await go('button.toggle');
  const later = Number((await page.textContent('.status')).match(/tick (\d+)/)[1]);
  assert.ok(later - ticks >= 4, `${later - ticks} ticks in 0.7 s at 10×`);
  assert.equal(await page.textContent(`${tile('NOVA')} .price`), (await price('NOVA')).toFixed(2));
  assert.deepEqual(messages, []);
  await page.close();
});
