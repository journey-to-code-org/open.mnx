// Preact: mnx elements used directly in Preact's JSX: objects as props (a habit's log), on<name>
// events, a CSS custom property from Preact's style prop reaching into the elements, lists that
// add and remove elements, and an mnx form control in a Preact form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('preact-habits: a habit tracker built from mnx elements', async () => {
  const { page, messages } = await launch('preact-habits');
  await page.waitForSelector('streak-grid button');
  await settle(page);
  const go = async (selector) => { await page.click(selector); await settle(page); };
  const habit = (id) => `li[data-id=${id}]`;
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const yesterday = await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });

  assert.deepEqual(await texts(page, '.habit h2'), ['Read 20 pages', 'Drink water', 'Walk outside', 'No phone after 10pm']);
  assert.equal(await page.textContent('.done-count'), '0/4');
  // The habit's colour comes from Preact's style prop, as a custom property the elements use.
  const blue = await page.$eval(`${habit('h1')} streak-grid button[data-level="4"]`, (el) => getComputedStyle(el).backgroundColor);
  assert.equal(blue, 'rgb(37, 99, 235)');
  assert.equal(await page.$eval(`${habit('h1')} streak-grid [data-today]`, (el) => el.dataset.day), today);

  // A yes/no habit: one click on the ring checks it, and the streak grows.
  const streak = Number((await page.textContent(`${habit('h1')} .streak`)).match(/\d+/)[0]);
  await go(`${habit('h1')} check-ring .ring`);
  assert.equal(await page.textContent(`${habit('h1')} check-ring .count`), '✓');
  assert.equal(await page.textContent(`${habit('h1')} .streak`), `🔥 ${streak + 1} days`);
  assert.equal(await page.textContent('.done-count'), '1/4');
  assert.equal(await page.$eval(`${habit('h1')} streak-grid [data-day="${today}"]`, (el) => el.dataset.level), '4', 'the grid follows');
  await go(`${habit('h1')} check-ring .less`);
  assert.equal(await page.textContent('.done-count'), '0/4');

  // A counted habit: eight clicks to reach the goal; the grid shades by how much was done.
  for (let i = 0; i < 4; i++) await page.click(`${habit('h2')} check-ring .ring`);
  await settle(page);
  assert.match(await page.textContent(`${habit('h2')} .name p`), /^4\/8 today/);
  assert.equal(await page.$eval(`${habit('h2')} streak-grid [data-day="${today}"]`, (el) => el.dataset.level), '2');
  for (let i = 0; i < 4; i++) await page.click(`${habit('h2')} check-ring .ring`);
  await settle(page);
  assert.equal(await page.getAttribute(`${habit('h2')} check-ring .ring`, 'aria-pressed'), 'true');
  assert.equal(await page.textContent('.done-count'), '1/4');

  // The grid: toggling yesterday changes the streak and the 30-day rate; arrows move focus.
  const walkStreak = await page.textContent(`${habit('h3')} .streak`);
  const walkRate = await page.textContent(`${habit('h3')} .rate`);
  const wasDone = await page.getAttribute(`${habit('h3')} streak-grid [data-day="${yesterday}"]`, 'aria-pressed');
  await go(`${habit('h3')} streak-grid [data-day="${yesterday}"]`);
  assert.equal(await page.getAttribute(`${habit('h3')} streak-grid [data-day="${yesterday}"]`, 'aria-pressed'), wasDone === 'true' ? 'false' : 'true');
  assert.notEqual(await page.textContent(`${habit('h3')} .rate`), walkRate);
  assert.notEqual(await page.textContent(`${habit('h3')} .streak`), walkStreak);
  await page.focus(`${habit('h3')} streak-grid [data-day="${today}"]`);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.day), await page.evaluate((day) => { const d = new Date(`${day}T12:00`); d.setDate(d.getDate() - 7); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, today));
  await page.keyboard.press('Enter');
  await settle(page);

  // A new habit, with an mnx colour picker (arrow keys) in a Preact form.
  await go('button.new');
  await page.fill('.add input[required]', 'Stretch');
  await page.fill('.add input[type=number]', '2');
  await page.focus('color-swatches [aria-checked=true]');
  await page.keyboard.press('ArrowRight');
  await settle(page);
  assert.equal(await page.$eval('color-swatches', (el) => el.value), '#ea580c');
  assert.equal(await page.evaluate(() => new FormData(document.querySelector('.add')).get('color')), '#ea580c', 'a form control in the form');
  await go('.add button[type=submit]');
  assert.deepEqual(await texts(page, '.habit h2'), ['Read 20 pages', 'Drink water', 'Walk outside', 'No phone after 10pm', 'Stretch']);
  const stretch = page.locator('.habit').nth(4);
  assert.equal(await stretch.locator('.streak').textContent(), 'No streak yet');
  assert.equal(await stretch.locator('streak-grid button[data-level="0"]').first().evaluate((el) => getComputedStyle(el.closest('li')).getPropertyValue('--habit').trim()), '#ea580c');
  await stretch.locator('check-ring .ring').click();
  await stretch.locator('check-ring .ring').click();
  await settle(page);
  assert.equal(await stretch.locator('.streak').textContent(), '🔥 1 day');
  assert.equal(await page.textContent('.done-count'), '2/5');

  // Delete; and everything survives a reload.
  await go(`${habit('h4')} .remove`);
  assert.equal(await page.locator('.habit').count(), 4);
  await page.reload();
  await page.waitForSelector('streak-grid button');
  await settle(page);
  assert.deepEqual(await texts(page, '.habit h2'), ['Read 20 pages', 'Drink water', 'Walk outside', 'Stretch']);
  assert.equal(await page.textContent('.done-count'), '2/4');
  assert.deepEqual(messages, []);
  await page.close();
});
