// FAST Element 3: a FASTElement app whose shadow root holds light-DOM zubra elements. Their scoped
// styles are adopted into that shadow root; :prop bindings set them and @valuechange bindings hear
// them; repeat() renders a line per item; and the currency is provided by FAST's Context and read by
// zubra's inject() (the context protocol). FAST's provider answers each request once, so the value is
// the page's, not one that changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('fast-orders: an order sheet built from zubra elements inside a FAST app', async () => {
  const { page, messages, url } = await launch('fast-orders');
  await page.goto(url);
  await page.waitForSelector('order-sheet line-price data');
  await settle(page);
  const line = (id) => page.locator(`order-sheet li[data-line=${id}]`);
  const prices = () => texts(page, 'order-sheet li line-price');
  const total = () => page.locator('order-sheet .total line-price').textContent().then((text) => text.trim());

  // The zubra elements are inside FAST's shadow root, and their styles reached it.
  assert.equal(await page.$eval('order-sheet', (el) => !!el.shadowRoot), true);
  assert.equal(await line('beans').locator('quantity-stepper button.more').evaluate((el) => getComputedStyle(el).borderRadius), '50%');

  // Down: FAST's :value and :amount bindings. Context: euros, from FAST's provider.
  assert.deepEqual(await texts(page, 'order-sheet li quantity-stepper output'), ['1', '2', '1']);
  assert.deepEqual(await prices(), ['€14.50', '€6.50', '€9.00']);
  assert.equal(await total(), '€30.00');

  // Up: the stepper's valuechange reaches FAST's handler, which recomputes the line and the total.
  await line('mug').locator('button.more').click();
  await line('mug').locator('button.more').click();
  await line('filters').locator('button.less').click();
  await settle(page);
  assert.deepEqual(await texts(page, 'order-sheet li quantity-stepper output'), ['1', '1', '3']);
  assert.deepEqual(await prices(), ['€14.50', '€3.25', '€27.00']);
  assert.equal(await total(), '€44.75');

  // Down again: FAST replaces its lines, and every stepper and price follows.
  await page.locator('order-sheet button.reset').click();
  await settle(page);
  assert.deepEqual(await texts(page, 'order-sheet li quantity-stepper output'), ['1', '2', '1']);
  assert.equal(await total(), '€30.00');

  // The steppers are form controls with accessible names from FAST's label binding.
  assert.equal(await page.getByRole('button', { name: 'More Enamel mug' }).count(), 1);
  assert.deepEqual(messages, []);
  await page.close();
});
