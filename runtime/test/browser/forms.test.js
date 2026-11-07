// Form-associated components: submitting, reset, validation, disabling and restore, through
// ElementInternals. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, compiler, engine } from './harness.js';

useBrowser({ stepper: join(here, 'fixtures/stepper.mnx'), choose: join(here, 'fixtures/select-value.mnx'), amount: join(here, 'fixtures/amount-field.mnx') });

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

test('reporting an invalid control focuses an element inside it', async () => {
  const { page, messages } = await open(FORM, { modules: ['stepper'] });
  await click(page, 'mnx-stepper .down');
  const reported = await page.evaluate(() => ({
    valid: document.getElementById('order').reportValidity(),
    focused: document.activeElement.closest('mnx-stepper') !== null && document.activeElement.localName,
  }));
  assert.deepEqual(reported, { valid: false, focused: 'button' });
  assert.deepEqual(messages, [], 'no "invalid form control is not focusable" error');
  await page.close();
});

test('submitting a form with an invalid control focuses the input inside it, in every engine', async () => {
  const forms = {
    // In the page's HTML, and created by a framework (set up, then given its props).
    html: '<form id="f"><mnx-amount name="amount" required></mnx-amount><button>Add</button></form>',
    created: '<form id="f"><button>Add</button></form><script type="module">const el = document.createElement("mnx-amount"); el.name = "amount"; el.required = true; document.getElementById("f").prepend(el);</script>',
  };
  for (const [how, html] of Object.entries(forms)) {
    const { page, messages } = await open(html, { modules: ['amount'] });
    await page.evaluate(() => customElements.whenDefined('mnx-amount').then(() => document.querySelector('mnx-amount')?.updateComplete));
    await page.waitForSelector('mnx-amount input');
    await page.click('#f button');
    const result = await page.evaluate(() => ({
      submitted: location.search !== '',
      focused: document.activeElement.closest('mnx-amount') !== null && document.activeElement.localName,
    }));
    assert.deepEqual(result, { submitted: false, focused: 'input' }, how);
    // Firefox focuses the input too, but also logs that the control "is not focusable"
    // (docs/browser-support.md).
    const noise = (message) => engine === 'firefox' && /[Ii]nvalid form control.* is not focusable/.test(message);
    assert.deepEqual(messages.filter((message) => !noise(message)), [], `${how}: no "invalid form control is not focusable" error`);
    await page.close();
  }
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
  assert.equal(message, 'mnx: formValue() needs form-associated on the component\'s host tag (see https://github.com/journey-to-code-org/open.mnx#forms)');
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

test('<select value> and <textarea value> are right in the server HTML, before JavaScript, and hydrate', async () => {
  const fixture = join(here, 'fixtures/select-value.mnx');
  const html = compiler(fixture);
  assert.match(html, /<option value="pending" selected>/);
  assert.match(html, /<textarea>Hi<\/textarea>/);
  assert.doesNotMatch(html, /<select value=/);
  // The server's HTML alone (no modules): the browser shows the right choice and text.
  let { page } = await open(html);
  assert.deepEqual(await page.evaluate(() => [document.querySelector('select').value, document.querySelector('textarea').value]), ['pending', 'Hi']);
  await page.close();
  // Hydrated: no mismatch, and the controls stay bound both ways.
  const opened = await open(html, { modules: ['choose'] });
  page = opened.page;
  await page.selectOption('select', 'solved');
  await page.fill('textarea', 'Done');
  await page.waitForFunction(() => document.querySelector('output').textContent === 'solved|Done');
  await page.evaluate(() => { document.querySelector('mnx-choose').status = 'open'; });
  await page.waitForFunction(() => document.querySelector('select').value === 'open');
  assert.deepEqual(opened.messages, []);
  await page.close();
});
