// Angular (reactive forms, compiled ahead of time with Analog's Vite plugin): mnx elements as
// form controls through MnxModel, with validation, a step indicator's events and a live summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('angular-booking: a booking wizard whose controls are mnx elements', async () => {
  const { page, messages } = await launch('angular-booking');
  await page.waitForSelector('choice-cards [role=radio]');
  await settle(page);
  const go = async (selector) => { await page.click(selector); await settle(page); };

  // Step 1: required destination; the date range and steppers are form controls too.
  await go('button.next');
  assert.deepEqual(await texts(page, '.error'), ['Choose a destination.']);
  assert.equal(await page.$eval('choice-cards', (el) => el.matches(':invalid')), true, 'the element is invalid on the platform too');
  await go('choice-cards [data-id=ridge]');
  assert.deepEqual(await texts(page, '.error'), []);
  assert.equal(await page.textContent('.summary .where'), 'Ridge lodge');
  await page.keyboard.press('ArrowRight');
  await settle(page);
  assert.equal(await page.textContent('.summary .where'), 'Coastal retreat', 'arrow keys move the choice');
  await page.keyboard.press('ArrowLeft');
  await settle(page);
  await go('quantity-stepper[label=adults] .more');
  await go('quantity-stepper[label=adults] .more');
  await go('quantity-stepper[label=children] .more');
  assert.equal(await page.textContent('.summary .who'), '4 adults, 1 child');
  // An invalid range: check-out before check-in.
  const start = await page.inputValue('date-range input.start');
  await page.fill('date-range input.end', start);
  await page.dispatchEvent('date-range input.end', 'change');
  await settle(page);
  assert.deepEqual(await texts(page, '.error'), ['Check-out must be at least a night after check-in.']);
  await go('button.next');
  assert.equal(await page.textContent('step-indicator [aria-current=step]'), 'Trip', 'an invalid step stays');
  const later = await page.evaluate((day) => new Date(Date.parse(day) + 2 * 86400000).toISOString().slice(0, 10), start);
  await page.fill('date-range input.end', later);
  await page.dispatchEvent('date-range input.end', 'change');
  await settle(page);
  assert.match(await page.textContent('.summary .when'), /· 2 nights$/);
  assert.equal(await page.textContent('date-range .nights'), '2 nights');
  await go('button.next');

  // Step 2: rooms too small for five are disabled.
  assert.equal(await page.textContent('step-indicator [aria-current=step]'), 'Room');
  assert.deepEqual(await page.$$eval('choice-cards [role=radio]', (els) => els.map((el) => `${el.dataset.id}:${el.disabled}`)), ['ridge-queen:true', 'ridge-bunk:true', 'ridge-suite:true']);
  await go('step-indicator li.done button');
  assert.equal(await page.textContent('step-indicator [aria-current=step]'), 'Trip', 'a finished step can be revisited');
  await go('quantity-stepper[label=adults] .less');
  await go('quantity-stepper[label=adults] .less');
  await go('button.next');
  assert.deepEqual(await page.$$eval('choice-cards [role=radio]', (els) => els.map((el) => `${el.dataset.id}:${el.disabled}`)), ['ridge-queen:true', 'ridge-bunk:false', 'ridge-suite:false']);
  await go('button.next');
  assert.deepEqual(await texts(page, '.error'), ['Choose a room that sleeps 3.']);
  await go('choice-cards [data-id=ridge-suite]');
  assert.deepEqual(await texts(page, '.summary td'), ['Summit suite × 2 nights', '$620', 'Taxes (12%)', '$74', 'Total', '$694']);
  await go('button.next');

  // Step 3: toggle switches bound through mnxModel="checked".
  await go('toggle-switch:has-text("Breakfast") button');
  await go('toggle-switch:has-text("Airport pickup") button');
  assert.equal(await page.textContent('toggle-switch:has-text("Breakfast") .extra'), '$108');
  assert.deepEqual(await texts(page, '.summary td'), ['Summit suite × 2 nights', '$620', 'Breakfast', '$108', 'Airport pickup', '$65', 'Taxes (12%)', '$95', 'Total', '$888']);
  await go('toggle-switch:has-text("Airport pickup") button');
  assert.equal(await page.textContent('.summary .total .num'), '$815');
  await go('button.back');
  await go('button.next');
  assert.equal(await page.getAttribute('toggle-switch:has-text("Breakfast") button', 'aria-checked'), 'true', 'the form keeps the value across steps');
  await go('button.next');

  // Step 4: native inputs with Angular validators, then book.
  assert.equal(await page.textContent('button.next'), 'Book for $815');
  await go('button.next');
  assert.deepEqual(await texts(page, '.error'), ['Enter your name.', 'Enter a valid email address.']);
  await page.fill('input[formcontrolname=name]', 'Ada Lovelace');
  await page.fill('input[formcontrolname=email]', 'ada@example.com');
  await go('button.next');
  assert.equal(await page.textContent('h1'), "You're booked");
  assert.match(await page.textContent('.reference'), /^MNX-[A-Z0-9]{6}$/);
  assert.match(await page.textContent('.confirmation'), /Summit suite at Ridge lodge, 2 nights for 3\. Total \$815\./);

  // Starting over resets every control, mnx ones included.
  await go('.confirmation button');
  assert.equal(await page.textContent('.summary .where'), 'Not chosen yet');
  assert.equal(await page.textContent('quantity-stepper[label=adults] output'), '2');
  assert.equal(await page.$('choice-cards [aria-checked=true]'), null);
  assert.deepEqual(messages, []);
  await page.close();
});
