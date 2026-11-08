// MUI with Zubra components in one React app: Zubra elements inside MUI's Grid and form layout;
// MUI's theme reaching them as CSS variables (`createTheme({ cssVariables })`), in a light-DOM
// card and a shadow-DOM form control; the colour scheme and the brand colour switched at runtime;
// a Zubra form control submitted with MUI's TextFields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('mui-clinic: MUI\'s theme styles Zubra components through its CSS variables', async () => {
  const { page, messages } = await launch('mui-clinic', { colorScheme: 'light' });
  await page.waitForSelector('doctor-card button');
  await settle(page);
  const style = (selector, property) => page.locator(selector).first().evaluate(async (el, property) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
    return getComputedStyle(el)[property];
  }, property);
  const muiVar = (name) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
  const appBar = '.MuiAppBar-root';

  // MUI writes its theme as CSS variables; the Zubra card's avatar is MUI's primary colour.
  assert.equal(await muiVar('--mui-palette-primary-main'), '#00796b');
  assert.equal(await style('doctor-card[data-id=okafor] .avatar', 'backgroundColor'), await style(appBar, 'backgroundColor'), 'the avatar and MUI\'s AppBar share primary.main');
  assert.equal(await style('doctor-card[data-id=okafor] button', 'borderTopLeftRadius'), '20px', 'shape.borderRadius (10) × 2');
  // The shadow-DOM picker before a doctor is chosen, and MUI's disabled submit button.
  assert.equal(await page.textContent('slot-picker .empty'), 'Choose a doctor and a day first.');
  assert.equal(await page.isDisabled('button[type=submit]'), true);

  // Choosing a doctor (a Zubra event, React state) fills the picker; MUI's day buttons change it.
  await page.click('doctor-card[data-id=lindqvist] button');
  await settle(page);
  assert.equal(await page.getAttribute('doctor-card[data-id=lindqvist] button', 'aria-pressed'), 'true');
  assert.equal(await page.locator('slot-picker [role=radio]').count(), 12);
  const taken = await page.locator('slot-picker [role=radio]:disabled').count();
  assert.ok(taken > 0 && taken < 12, 'some times are taken');

  // Submitting without a time: MUI's FormHelperText, from the Zubra control's missing value.
  await page.click('button[type=submit]');
  await settle(page);
  assert.equal(await page.textContent('.MuiFormHelperText-root'), 'Choose a time.');
  assert.equal(await style('.Mui-error.MuiFormLabel-root', 'color'), await style('.MuiFormHelperText-root', 'color'));

  // The picker inside its shadow root: MUI's primary colour on the chosen time.
  const free = 'slot-picker [role=radio]:not(:disabled)';
  const firstFree = await page.locator(free).first().getAttribute('data-time');
  await page.locator(free).first().click();
  await settle(page);
  assert.equal(await style(`slot-picker [data-time="${firstFree}"]`, 'backgroundColor'), await style(appBar, 'backgroundColor'), 'aria-checked: primary.main');
  assert.equal(await style(`slot-picker [data-time="${firstFree}"]`, 'color'), 'rgb(255, 255, 255)', 'primary.contrastText');
  assert.equal(await page.locator('.MuiFormHelperText-root').count(), 0, 'the error clears');
  // Arrow keys skip taken times.
  await page.keyboard.press('ArrowRight');
  await settle(page);
  const second = await page.locator(free).nth(1).getAttribute('data-time');
  assert.equal(await page.getAttribute(`slot-picker [data-time="${second}"]`, 'aria-checked'), 'true');

  // The brand colour: a new MUI theme, new variables, and the Zubra components follow.
  await page.click('[aria-label="Brand colour"] button:has-text("Indigo")');
  await settle(page);
  assert.equal(await muiVar('--mui-palette-primary-main'), '#3949ab');
  assert.equal(await style('doctor-card[data-id=okafor] .avatar', 'backgroundColor'), 'rgb(57, 73, 171)');
  assert.equal(await style(`slot-picker [data-time="${second}"]`, 'backgroundColor'), 'rgb(57, 73, 171)', 'inside the shadow root too');

  // Dark mode (MUI's useColorScheme): the paper and text variables change for both.
  await page.click('button:has-text("Dark mode")');
  await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
  assert.equal(await style('doctor-card button', 'backgroundColor'), await style('.MuiPaper-outlined', 'backgroundColor'), 'the cards sit on MUI\'s dark paper');
  assert.equal(await style('slot-picker [role=radio]:not([aria-checked=true])', 'color'), 'rgb(255, 255, 255)', 'text.primary in dark mode');

  // Booking: the picker's value is submitted with MUI's TextFields.
  await page.click('button[type=submit]');
  await page.waitForSelector('[role=status]');
  assert.equal(await page.textContent('[role=status] .MuiAlert-message'), `Sam Rivera, you're booked with Dr. Erik Lindqvist on Tue 10 at ${second} (Check-up).`);

  assert.deepEqual(messages, []);
  await page.close();
});
