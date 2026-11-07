// Vue 3: mnx elements imported as Vue components. v-model on mnx elements (form controls
// included, and in a v-for), slot content from a Vue template, events, and an SVG chart whose
// segments come from Vue's computed state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('vue-budget: a budget tracker built from mnx elements', async () => {
  const { page, messages } = await launch('vue-budget');
  await page.waitForSelector('donut-chart circle[data-label]');
  await settle(page);
  const go = async (selector) => { await page.click(selector); await settle(page); };
  const totals = async () => [await page.textContent('.totals .income'), await page.textContent('.totals .spent'), await page.textContent('.totals .left')];

  assert.deepEqual(await totals(), ['$4,550.00', '$2,194.29', '$2,355.71']);
  // The donut's segments are SVG circles (rows of a list inside <svg>).
  assert.deepEqual(await page.$$eval('donut-chart circle[data-label]', (els) => els.map((el) => `${el.dataset.label}:${el.namespaceURI.endsWith('svg')}`)),
    ['Housing:true', 'Groceries:true', 'Eating out:true', 'Transport:true', 'Fun:true', 'Bills:true']);
  assert.equal(await page.textContent('donut-chart .middle-total'), '$2,194.29', 'slot content from Vue');
  assert.deepEqual(await page.$$eval('budget-bar > div', (els) => els.map((el) => el.dataset.state)), ['near', 'ok', 'near', 'ok', 'ok', 'ok', 'ok']);

  // v-model on the donut: choosing a segment filters the list; choosing it again clears it.
  // (A ring's centre is its hole, so the click goes to the circle itself.)
  await page.dispatchEvent('donut-chart circle[data-label="Eating out"]', 'click');
  await settle(page);
  assert.equal(await page.textContent('.filter'), 'Only Eating out Show all');
  assert.deepEqual(await texts(page, '.list li b'), ['Birthday dinner', 'Ramen with Sam']);
  assert.equal(await page.textContent('donut-chart .middle-total'), '$171.25');
  await go('donut-chart button[data-label="Eating out"]');
  assert.equal(await page.$('.filter'), null);
  // v-model on the segmented control.
  await go('.list-head segmented-control button[data-value=income]');
  assert.deepEqual(await texts(page, '.list li b'), ['Logo project', 'Monthly pay']);
  await go('.list-head segmented-control button[data-value=all]');

  // Adding: the money input is a form control, so the form won't submit without an amount.
  await go('.add button[type=submit]');
  assert.equal(await page.$eval('.add money-input', (el) => el.matches(':invalid')), true);
  assert.deepEqual(await totals(), ['$4,550.00', '$2,194.29', '$2,355.71']);
  await page.fill('.add money-input input', '23.5');
  await page.selectOption('.add select', 'Eating out');
  await page.fill('.add input[aria-label=Note]', 'Tacos');
  await page.locator('.add money-input input').blur();
  await settle(page);
  assert.equal(await page.inputValue('.add money-input input'), '23.50', 'formatted on blur');
  await go('.add button[type=submit]');
  assert.deepEqual(await totals(), ['$4,550.00', '$2,217.79', '$2,332.21']);
  assert.equal(await page.inputValue('.add money-input input'), '', 'v-model cleared it');
  assert.equal(await page.$eval('budget-bar[data-category="Eating out"] > div', (el) => el.dataset.state), 'over');
  assert.match(await page.textContent('budget-bar[data-category="Eating out"] .numbers'), /\$194\.75 \/ \$180\.00 · \$14\.75 over/);
  // Income: the segmented control switches the categories.
  await go('.add segmented-control button[data-value=income]');
  assert.deepEqual(await page.$$eval('.add select option', (els) => els.map((el) => el.value)), ['Salary', 'Freelance', 'Gift']);
  await page.fill('.add money-input input', '1,000');
  await page.selectOption('.add select', 'Gift');
  await go('.add button[type=submit]');
  assert.equal(await page.textContent('.totals .income'), '$5,550.00');

  // Budget limits: a money input per category, v-model into a reactive object, in a v-for.
  await go('details summary');
  await page.fill('money-input input[aria-label="Eating out limit"]', '250');
  await settle(page);
  assert.equal(await page.$eval('budget-bar[data-category="Eating out"] > div', (el) => el.dataset.state), 'ok');

  // Delete, then another month.
  await go('li:has-text("Tacos") button.remove');
  assert.equal(await page.textContent('.totals .spent'), '$2,194.29');
  await go('button.prev');
  assert.notEqual(await page.textContent('.month'), await page.evaluate(() => new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })));
  assert.deepEqual(await totals(), ['$4,800.00', '$2,072.54', '$2,727.46']);
  await go('button.next');
  await go('button.next');
  assert.equal(await page.textContent('.empty'), 'No spending this month.');
  assert.equal(await page.$('donut-chart'), null);

  // Saved across reloads, limits included.
  await page.reload();
  await page.waitForSelector('donut-chart');
  await settle(page);
  assert.equal(await page.textContent('.totals .income'), '$5,550.00');
  assert.match(await page.textContent('budget-bar[data-category="Eating out"] .numbers'), /\/ \$250\.00/);
  assert.deepEqual(messages, []);
  await page.close();
});
