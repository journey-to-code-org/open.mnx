// Bootstrap 5 with Zubra components, no framework: Bootstrap's classes in a light-DOM component's
// template; Bootstrap's Sass theme reaching a shadow-DOM form control as CSS variables; that form
// control taking part in Bootstrap's validation (:invalid, .invalid-feedback); Bootstrap's Modal;
// colour modes (data-bs-theme).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle } from './harness.js';

test('bootstrap-devday: Bootstrap\'s classes, Sass theme and validation work with Zubra components', async () => {
  const { page, messages } = await launch('bootstrap-devday', { colorScheme: 'light' });
  await page.waitForSelector('ticket-picker [role=radio]');
  await settle(page);
  const style = (selector, property) => page.locator(selector).first().evaluate(async (el, property) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
    return getComputedStyle(el)[property];
  }, property);
  const violet = 'rgb(109, 40, 217)'; // $primary in src/theme.scss

  // The Sass variable became --bs-primary: Bootstrap's button and the shadow-DOM picker share it.
  assert.equal(await style('button[type=submit]', 'backgroundColor'), violet);
  assert.equal(await style('ticket-picker .price', 'color'), violet, 'var(--bs-primary) inside the shadow root');
  assert.equal(await style('ticket-picker [role=radio]', 'borderTopLeftRadius'), '14.4px', '$border-radius-lg: 0.9rem');
  // The light-DOM list is Bootstrap's own markup: list-group, form-check-input, badges.
  assert.equal(await style('session-list .list-group', 'borderTopLeftRadius'), '9.6px', '.list-group with $border-radius: 0.6rem');
  assert.equal(await style('session-list .badge.text-bg-success', 'backgroundColor'), 'rgb(25, 135, 84)', '.text-bg-success');
  assert.equal(await page.isDisabled('session-list input[data-id=perf]'), true, 'a full workshop');

  // Submitting empty: Bootstrap's .was-validated styles match the Zubra control's :invalid, and
  // its .invalid-feedback after it shows.
  await page.fill('#email', '');
  await page.click('button[type=submit]');
  await settle(page);
  assert.equal(await page.evaluate(() => document.querySelector('ticket-picker').matches(':invalid')), true);
  assert.equal(await page.evaluate(() => document.querySelector('ticket-picker').validationMessage), 'Choose a ticket.');
  assert.equal(await style('ticket-picker + .invalid-feedback', 'display'), 'block');
  assert.equal(await style('ticket-picker [role=radio]', 'borderTopColor'), await style('#email', 'borderTopColor'), 'the same invalid border as Bootstrap\'s inputs');
  assert.equal(await page.isVisible('#done'), false);

  // Choosing a ticket clears it, and the total follows.
  await page.click('ticket-picker [data-id=standard]');
  await settle(page);
  assert.equal(await page.evaluate(() => document.querySelector('ticket-picker').matches(':valid')), true);
  assert.equal(await style('ticket-picker + .invalid-feedback', 'display'), 'none');
  assert.equal(await page.textContent('#total'), '€149');
  await page.keyboard.press('ArrowRight');
  await settle(page);
  assert.equal(await page.textContent('#total'), '€249', 'arrow keys move the choice');

  // Up to two workshops: the third is disabled once two are picked.
  await page.check('session-list input[data-id=a11y]');
  await page.check('session-list input[data-id=wc]');
  await settle(page);
  assert.equal(await page.isDisabled('session-list input[data-id=css]'), true);
  assert.match(await page.textContent('session-list .form-text'), /You've picked 2/);
  await page.uncheck('session-list input[data-id=a11y]');
  await settle(page);
  assert.equal(await page.isDisabled('session-list input[data-id=css]'), false);
  await page.check('session-list input[data-id=css]');

  // Registering: the picker's value comes with the form; Bootstrap's Modal shows the summary.
  await page.fill('#email', 'ines@example.com');
  await page.evaluate(() => {
    window.modalShown = new Promise((done) => document.querySelector('#done').addEventListener('shown.bs.modal', done, { once: true }));
  });
  await page.click('button[type=submit]');
  await page.waitForSelector('#done.show');
  assert.equal(await page.textContent('#done-body'),
    'Inês Costa: a Supporter ticket (€249), with Modern CSS layout and Web components in any framework. Details are on their way to ines@example.com.');
  // Bootstrap's Modal ignores hide() while it is still opening, so a click that lands during the
  // transition leaves it open: wait for its shown event first.
  await page.evaluate(() => window.modalShown);
  await page.click('#done .modal-footer button');
  await page.waitForSelector('#done', { state: 'hidden' });

  // Colour modes: data-bs-theme switches Bootstrap's variables, inside the shadow root too.
  await page.click('#mode');
  await settle(page);
  assert.equal(await style('ticket-picker [role=radio]:not([aria-checked=true])', 'backgroundColor'), await style('.card', 'backgroundColor'), 'the cards are --bs-body-bg in dark mode');
  assert.equal(await style('ticket-picker .name', 'color'), await style('.card-body h2', 'color'));

  assert.deepEqual(messages, []);
  await page.close();
});
