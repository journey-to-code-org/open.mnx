// Form-associated components: submitting, reset, validation, disabling and restore, through
// ElementInternals. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({ stepper: join(here, 'fixtures/stepper.mnx') });

const FORM = `<form id="order"><fieldset id="set"><label id="lbl">Qty <mnx-stepper name="qty"></mnx-stepper></label></fieldset>
  <input name="note" value="x"><button type="reset">Reset</button></form>`;

async function click(page, selector, times = 1) {
  for (let i = 0; i < times; i++) await page.click(selector);
  await page.evaluate(() => document.querySelector('mnx-stepper').updateComplete);
}

test('the value is submitted with the form under its name', async () => {
  const { page, messages } = await open(FORM, { modules: ['stepper'] });
  await click(page, 'mnx-stepper .up', 3);
  const result = await page.evaluate(() => {
    const el = document.querySelector('mnx-stepper');
    return {
      data: [...new FormData(document.getElementById('order'))],
      form: el.form?.id,
      name: el.name,
      labelled: el.labels?.[0]?.id,
    };
  });
  assert.deepEqual(result.data, [['qty', '3'], ['note', 'x']]);
  assert.equal(result.form, 'order', 'element.form is the owning form');
  assert.equal(result.name, 'qty');
  assert.equal(result.labelled, 'lbl', 'a wrapping <label> labels it');
  assert.deepEqual(messages, []);
  await page.close();
});

test('resetting the form resets the control', async () => {
  const { page } = await open(FORM, { modules: ['stepper'] });
  await click(page, 'mnx-stepper .up', 2);
  await page.click('button[type=reset]');
  await page.evaluate(() => document.querySelector('mnx-stepper').updateComplete);
  assert.equal(await page.$eval('mnx-stepper output', (output) => output.textContent), '0');
  assert.deepEqual(await page.evaluate(() => [...new FormData(document.getElementById('order'))][0]), ['qty', '0']);
  await page.close();
});

test('an invalid value blocks submission and reports its message', async () => {
  const { page } = await open(FORM, { modules: ['stepper'] });
  await click(page, 'mnx-stepper .down');
  const invalid = await page.evaluate(() => {
    const el = document.querySelector('mnx-stepper');
    return {
      control: el.checkValidity(),
      form: document.getElementById('order').checkValidity(),
      message: el.validationMessage,
      customError: el.validity.customError,
      matches: el.matches(':invalid'),
    };
  });
  assert.deepEqual(invalid, { control: false, form: false, message: 'Must be zero or more', customError: true, matches: true });
  await click(page, 'mnx-stepper .up');
  const valid = await page.evaluate(() => ({
    form: document.getElementById('order').checkValidity(),
    matches: document.querySelector('mnx-stepper').matches(':valid'),
  }));
  assert.deepEqual(valid, { form: true, matches: true }, 'validity follows the value');
  await page.close();
});

test('a disabled fieldset disables the control and leaves it out of the form data', async () => {
  const { page } = await open(FORM, { modules: ['stepper'] });
  await click(page, 'mnx-stepper .up');
  const result = await page.evaluate(async () => {
    const el = document.querySelector('mnx-stepper');
    document.getElementById('set').disabled = true;
    await el.updateComplete;
    const whileDisabled = {
      matches: el.matches(':disabled'),
      buttons: [...el.querySelectorAll('button')].map((button) => button.disabled),
      data: [...new FormData(document.getElementById('order'))].map(([key]) => key),
    };
    document.getElementById('set').disabled = false;
    await el.updateComplete;
    return { whileDisabled, after: [...el.querySelectorAll('button')].map((button) => button.disabled) };
  });
  assert.deepEqual(result.whileDisabled, { matches: true, buttons: [true, true], data: ['note'] });
  assert.deepEqual(result.after, [false, false]);
  await page.close();
});

test('a control that starts inside a disabled fieldset starts disabled', async () => {
  const { page } = await open('<form><fieldset disabled><mnx-stepper name="q"></mnx-stepper></fieldset></form>', { modules: ['stepper'] });
  assert.deepEqual(await page.$$eval('mnx-stepper button', (buttons) => buttons.map((button) => button.disabled)), [true, true]);
  await page.close();
});

test('a restored value (back/forward, autofill) comes back through onFormRestore', async () => {
  const { page } = await open(FORM, { modules: ['stepper'] });
  const shown = await page.evaluate(async () => {
    const el = document.querySelector('mnx-stepper');
    el.formStateRestoreCallback('7', 'restore');   // what the browser calls when restoring
    await el.updateComplete;
    return el.querySelector('output').textContent;
  });
  assert.equal(shown, '7');
  await page.close();
});

test('form hooks in a component without form-associated explain themselves', async () => {
  const { page } = await open('', { modules: [] });
  const message = await page.evaluate(async () => {
    const { $define, ABI, formValue } = await import('@mnx/runtime');
    let error;
    $define('plain-thing', { abi: ABI, setup() { try { formValue(1); } catch (caught) { error = caught.message; } return []; } });
    document.body.append(document.createElement('plain-thing'));
    return error;
  });
  assert.equal(message, 'mnx: formValue() needs form-associated on the component\'s host tag');
  await page.close();
});

test('a control inserted into a disabled fieldset after it is defined starts disabled', async () => {
  const { page } = await open('<form><fieldset disabled id="late"></fieldset></form>', { modules: ['stepper'] });
  const buttons = await page.evaluate(async () => {
    const el = document.createElement('mnx-stepper');
    document.getElementById('late').append(el);
    await el.updateComplete;
    return [...el.querySelectorAll('button')].map((button) => button.disabled);
  });
  assert.deepEqual(buttons, [true, true]);
  await page.close();
});
