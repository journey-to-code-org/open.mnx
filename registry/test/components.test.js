// The registry's components in Chromium: each is found by its role and accessible name (what a
// screen reader announces), works from the keyboard, and fires its events. They're compiled by
// the CLI and served with the runtime, as in runtime/test/browser. `node --test registry/test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useBrowser, open } from '../../runtime/test/browser/harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const names = readdirSync(join(here, '../components')).filter((file) => file.endsWith('.mnx')).map((file) => file.slice(0, -4));
useBrowser(Object.fromEntries(names.map((name) => [name, join(here, '../components', `${name}.mnx`)])));

/** Open `body` with `name`'s module, recording the events listed on window.events. */
async function page(name, body, events = []) {
  const { page, messages } = await open(body, {
    beforeModules: `window.events = []; for (const type of ${JSON.stringify(events)}) document.addEventListener(type, (event) => window.events.push([type, event.detail]), true);`,
    modules: [name],
  });
  await settle(page);
  return { page, messages, events: () => page.evaluate(() => window.events) };
}
const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all([...document.querySelectorAll('*')].filter((el) => el.updateComplete).map((el) => el.updateComplete));
});
const formData = (page) => page.evaluate(() => Object.fromEntries(new FormData(document.querySelector('form'))));
const done = async (page, messages) => {
  assert.deepEqual(messages, []);
  await page.close();
};

test('every registry component is tested here', () => {
  assert.equal(names.length, 20);
});

// ---- inputs ---------------------------------------------------------------------------------

test('tag-input: Enter and comma add, Backspace removes, × buttons are named; a form value', async () => {
  const { page: p, messages, events } = await page('tag-input', '<form><tag-input name="tags" label="Topics"></tag-input></form>', ['valuechange']);
  const field = p.getByRole('combobox', { name: 'Topics' });
  await field.fill('Design Systems');
  await field.press('Enter');
  await field.fill('a11y');
  await field.press(',');
  await settle(p);
  assert.deepEqual(await events(), [['valuechange', ['design-systems']], ['valuechange', ['design-systems', 'a11y']]]);
  assert.equal((await formData(p)).tags, 'design-systems,a11y');
  await p.getByRole('button', { name: 'Remove design-systems' }).click();
  await field.press('Backspace');
  await settle(p);
  assert.deepEqual((await events()).at(-1), ['valuechange', []]);
  await done(p, messages);
});

test('date-range: labelled date fields; invalid until both are set; nights announced', async () => {
  const { page: p, messages, events } = await page('date-range', '<form><date-range name="stay" min="2026-01-01"></date-range></form>', ['valuechange']);
  assert.equal(await p.evaluate(() => document.querySelector('date-range').checkValidity()), false);
  await p.getByLabel('Check-in').fill('2026-03-10');
  await p.getByLabel('Check-out').fill('2026-03-13');
  await settle(p);
  assert.equal(await p.textContent('date-range .nights'), '3 nights');
  assert.equal(await p.evaluate(() => document.querySelector('date-range').checkValidity()), true);
  assert.equal((await formData(p)).stay, '2026-03-10/2026-03-13');
  assert.deepEqual((await events()).at(-1), ['valuechange', { start: '2026-03-10', end: '2026-03-13' }]);
  await done(p, messages);
});

test('money-input: a labelled field; typed amounts are numbers, formatted on blur; required', async () => {
  const { page: p, messages, events } = await page('money-input', '<form><money-input name="amount" label="Budget" required></money-input></form>', ['valuechange']);
  assert.equal(await p.evaluate(() => document.querySelector('money-input').validationMessage), 'Enter an amount');
  const field = p.getByRole('textbox', { name: 'Budget' });
  await field.fill('1234.5');
  await field.blur();
  await settle(p);
  assert.equal(await field.inputValue(), '1,234.50');
  assert.deepEqual((await events()).at(-1), ['valuechange', 1234.5]);
  assert.equal((await formData(p)).amount, '1234.5');
  await done(p, messages);
});

test('star-rating: a named group of named buttons; keyboard picks; required; reset', async () => {
  const { page: p, messages, events } = await page('star-rating', '<form><star-rating name="stars" label="Your rating" required></star-rating><button type="reset">Reset</button></form>', ['valuechange']);
  const group = p.getByRole('group', { name: 'Your rating' });
  assert.equal(await group.getByRole('button').count(), 5);
  await group.getByRole('button', { name: '4 of 5' }).focus();
  await p.keyboard.press('Enter');
  await settle(p);
  assert.equal(await group.getByRole('button', { name: '4 of 5' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await events(), [['valuechange', 4]]);
  assert.equal((await formData(p)).stars, '4');
  await p.getByRole('button', { name: 'Reset' }).click();
  await settle(p);
  assert.equal(await p.evaluate(() => document.querySelector('star-rating').value), 0);
  assert.equal(await p.evaluate(() => document.querySelector('star-rating').checkValidity()), false);
  await done(p, messages);
});

test('toggle-switch: a named switch; Space toggles it; submits "on"', async () => {
  const { page: p, messages, events } = await page('toggle-switch', '<form><toggle-switch name="alerts" label="Email alerts" description="Daily digest"></toggle-switch></form>', ['checkedchange']);
  const control = p.getByRole('switch', { name: /Email alerts/ });
  assert.equal(await control.getAttribute('aria-checked'), 'false');
  await control.focus();
  await p.keyboard.press('Space');
  await settle(p);
  assert.equal(await control.getAttribute('aria-checked'), 'true');
  assert.deepEqual(await events(), [['checkedchange', true]]);
  assert.equal((await formData(p)).alerts, 'on');
  await done(p, messages);
});

const CHOICES = JSON.stringify([
  { id: 'std', title: 'Standard', detail: 'Queen bed' },
  { id: 'sea', title: 'Sea view', detail: 'Balcony', disabled: true },
  { id: 'suite', title: 'Suite', detail: 'Two rooms' },
]);

test('choice-cards: a radio group with one tab stop; arrows move the choice, skipping disabled', async () => {
  const { page: p, messages, events } = await page('choice-cards', '<form><choice-cards name="room" label="Room" required></choice-cards></form>', ['valuechange']);
  await p.evaluate((items) => { document.querySelector('choice-cards').items = JSON.parse(items); }, CHOICES);
  await settle(p);
  const group = p.getByRole('radiogroup', { name: 'Room' });
  assert.equal(await group.getByRole('radio').count(), 3);
  assert.equal(await p.locator('choice-cards [role=radio][tabindex="0"]').count(), 1, 'one tab stop');
  await group.getByRole('radio', { name: /Standard/ }).focus();
  await p.keyboard.press('ArrowDown');
  await settle(p);
  assert.equal(await group.getByRole('radio', { name: /Suite/ }).getAttribute('aria-checked'), 'true', 'the disabled card is skipped');
  assert.equal(await p.evaluate(() => document.activeElement.closest('choice-cards') && document.querySelector('choice-cards [aria-checked=true]') === document.activeElement), true, 'focus follows');
  assert.deepEqual(await events(), [['valuechange', 'suite']]);
  assert.equal((await formData(p)).room, 'suite');
  await done(p, messages);
});

test('color-swatches: a radio group of named colours; arrows wrap around', async () => {
  const { page: p, messages, events } = await page('color-swatches', '<color-swatches label="Habit colour"></color-swatches>', ['valuechange']);
  const group = p.getByRole('radiogroup', { name: 'Habit colour' });
  await group.getByRole('radio', { name: '#16a34a' }).focus();
  await p.keyboard.press('ArrowLeft');
  await settle(p);
  assert.equal(await group.getByRole('radio', { name: '#0891b2' }).getAttribute('aria-checked'), 'true');
  assert.deepEqual(await events(), [['valuechange', '#0891b2']]);
  await done(p, messages);
});

test('quantity-stepper: named buttons, disabled at the limits; an announced value', async () => {
  const { page: p, messages, events } = await page('quantity-stepper', '<form><quantity-stepper name="n" label="Guests" max="2"></quantity-stepper></form>', ['valuechange']);
  const more = p.getByRole('button', { name: 'More Guests' });
  await more.click();
  await settle(p);
  assert.equal(await more.isDisabled(), true);
  assert.equal(await p.getByRole('status', { name: 'Guests' }).textContent(), '2');
  assert.deepEqual(await events(), [['valuechange', 2]]);
  assert.equal((await formData(p)).n, '2');
  await done(p, messages);
});

test('segmented-control: a named group of toggle buttons', async () => {
  const { page: p, messages, events } = await page('segmented-control', '<segmented-control label="Period" value="m"></segmented-control>', ['valuechange']);
  await p.evaluate(() => { document.querySelector('segmented-control').options = [{ value: 'w', label: 'Week' }, { value: 'm', label: 'Month' }]; });
  await settle(p);
  const group = p.getByRole('group', { name: 'Period' });
  assert.equal(await group.getByRole('button', { name: 'Month' }).getAttribute('aria-pressed'), 'true');
  await group.getByRole('button', { name: 'Week' }).focus();
  await p.keyboard.press('Enter');
  await settle(p);
  assert.equal(await group.getByRole('button', { name: 'Week' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await events(), [['valuechange', 'w']]);
  await done(p, messages);
});

// ---- display --------------------------------------------------------------------------------

test('donut-chart: a labelled image, and a legend of toggle buttons that select a segment', async () => {
  const { page: p, messages, events } = await page('donut-chart', '<donut-chart label="Spending"></donut-chart>', ['valuechange']);
  await p.evaluate(() => { document.querySelector('donut-chart').segments = [{ label: 'Rent', value: 3, tone: 0 }, { label: 'Food', value: 1, tone: 1 }]; });
  await settle(p);
  assert.equal(await p.getByRole('img', { name: 'Spending' }).count(), 1);
  const food = p.getByRole('button', { name: /Food/ });
  assert.match(await food.textContent(), /25%/);
  await food.focus();
  await p.keyboard.press('Enter');
  await settle(p);
  assert.equal(await food.getAttribute('aria-pressed'), 'true');
  await p.keyboard.press('Enter');
  await settle(p);
  assert.deepEqual(await events(), [['valuechange', 'Food'], ['valuechange', '']]);
  await done(p, messages);
});

test('spark-line, line-chart, progress-ring: images named with what they show', async () => {
  for (const [name, body, expected] of [
    ['spark-line', '<spark-line label="AAPL"></spark-line>', 'AAPL: down'],
    ['line-chart', '<line-chart label="AAPL"></line-chart>', 'AAPL: 3 points from 1.00 to 3.00'],
    ['progress-ring', '<progress-ring label="Reviewed" value="30" max="40"></progress-ring>', 'Reviewed: 75%'],
  ]) {
    const { page: p, messages } = await page(name, body);
    if (name !== 'progress-ring') {
      await p.evaluate((name) => { document.querySelector(name).points = name === 'spark-line' ? [3, 2, 1] : [1, 3, 2]; }, name);
      await settle(p);
    }
    assert.equal(await p.getByRole('img', { name: expected }).count(), 1, `${name}: ${await p.locator('[role=img]').first().getAttribute('aria-label')}`);
    await done(p, messages);
  }
});

test('streak-grid: a named group of day buttons; arrow keys move by day and week; today is the tab stop', async () => {
  const { page: p, messages, events } = await page('streak-grid', '<streak-grid label="Reading" today="2026-03-18" weeks="2" goal="1"></streak-grid>', ['daytoggle']);
  await p.evaluate(() => { document.querySelector('streak-grid').log = { '2026-03-17': 1 }; });
  await settle(p);
  const group = p.getByRole('group', { name: 'Reading' });
  const today = group.getByRole('button', { name: 'Wed, Mar 18: 0/1' });
  assert.equal(await today.getAttribute('tabindex'), '0');
  assert.equal(await group.getByRole('button', { name: 'Tue, Mar 17: 1/1' }).getAttribute('aria-pressed'), 'true');
  await today.focus();
  await p.keyboard.press('ArrowUp');
  assert.equal(await p.evaluate(() => document.activeElement.dataset.day), '2026-03-17');
  await p.keyboard.press('ArrowLeft');
  assert.equal(await p.evaluate(() => document.activeElement.dataset.day), '2026-03-10');
  await p.keyboard.press('Enter');
  assert.deepEqual(await events(), [['daytoggle', '2026-03-10']]);
  await done(p, messages);
});

test('flip-card: a toggle button named by the face showing; Space and Enter flip it', async () => {
  const { page: p, messages, events } = await page('flip-card', '<flip-card><span slot="front">Capital of France?</span><span slot="back">Paris</span></flip-card>', ['flippedchange']);
  const card = p.getByRole('button', { name: /Capital of France\?/ });
  assert.equal(await card.getAttribute('aria-pressed'), 'false');
  await card.focus();
  await p.keyboard.press('Space');
  await settle(p);
  assert.equal(await p.getByRole('button', { name: /Paris/ }).getAttribute('aria-pressed'), 'true');
  await p.keyboard.press('Enter');
  assert.deepEqual(await events(), [['flippedchange', true], ['flippedchange', false]]);
  await done(p, messages);
});

test('step-indicator: a progress navigation; the current step is marked; done steps can be revisited', async () => {
  const { page: p, messages, events } = await page('step-indicator', '<step-indicator current="1"></step-indicator>', ['stepselect']);
  await p.evaluate(() => { document.querySelector('step-indicator').steps = ['Dates', 'Room', 'Pay']; });
  await settle(p);
  const nav = p.getByRole('navigation', { name: 'Progress' });
  assert.equal(await nav.getByRole('button', { name: 'Room' }).getAttribute('aria-current'), 'step');
  assert.equal(await nav.getByRole('button', { name: 'Pay' }).isDisabled(), true);
  await nav.getByRole('button', { name: 'Dates' }).focus();
  await p.keyboard.press('Enter');
  assert.deepEqual(await events(), [['stepselect', 0]]);
  await done(p, messages);
});

// ---- app pieces -----------------------------------------------------------------------------

test('kanban-column: a region named by its heading; a dropped card reports where; actions only when given', async () => {
  const { page: p, messages, events } = await page('kanban-column', `
    <kanban-column heading="Doing" count="2"><div data-id="a">A</div><div data-id="b">B</div></kanban-column>
    <kanban-column heading="Done" count="0"><button slot="actions">Add</button></kanban-column>`, ['carddrop']);
  assert.equal(await p.getByRole('region', { name: 'Doing' }).count(), 1);
  assert.deepEqual(await p.$$eval('kanban-column', (els) => els.map((el) => !!el.querySelector('footer'))), [false, true]);
  await p.evaluate(() => {
    const section = document.querySelector('kanban-column section');
    const data = new DataTransfer();
    data.setData('application/x-card', 'z');
    const second = section.querySelector('[data-id=b]').getBoundingClientRect();
    section.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    section.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true, clientY: second.top + 1 }));
  });
  assert.deepEqual(await events(), [['carddrop', { id: 'z', index: 1 }]]);
  await done(p, messages);
});

test('chat-message: your messages, mentions of you and your reactions are marked; a named toolbar', async () => {
  const { page: p, messages, events } = await page('chat-message', '<chat-message me="Ada Lovelace"></chat-message>', ['reacttoggle', 'reply']);
  await p.evaluate(() => {
    document.querySelector('chat-message').message = { id: '1', author: 'Grace Hopper', text: 'Ping @ada, see https://example.com', time: 0, reactions: { '👍': ['Ada Lovelace'] }, replyTo: null };
  });
  await settle(p);
  assert.equal(await p.locator('chat-message .mention.me').textContent(), '@ada');
  assert.equal(await p.getByRole('link', { name: 'https://example.com' }).count(), 1);
  assert.equal(await p.locator('chat-message .reactions button').getAttribute('aria-pressed'), 'true');
  const tools = p.getByRole('toolbar', { name: 'Message actions' });
  // Reachable from the keyboard: Tab from the reaction lands in the toolbar, which then shows.
  await p.locator('chat-message .reactions button').focus();
  await p.keyboard.press('Tab');
  assert.equal(await p.evaluate(() => document.activeElement.getAttribute('aria-label')), 'React 👍');
  assert.equal(await p.$eval('chat-message .tools', (el) => getComputedStyle(el).opacity), '1');
  await tools.getByRole('button', { name: 'React 🎉' }).click();
  await tools.getByRole('button', { name: 'Reply' }).click();
  assert.deepEqual(await events(), [['reacttoggle', '🎉'], ['reply', null]]);
  await done(p, messages);
});

test('message-composer: a labelled box; Enter sends, Shift+Enter is a new line; the emoji picker', async () => {
  // (Below the top of the page: the picker opens upwards.)
  const { page: p, messages, events } = await page('message-composer', '<div style="height: 320px"></div><message-composer placeholder="Message #general"></message-composer>', ['send']);
  const box = p.getByRole('textbox', { name: 'Message #general' });
  const send = p.getByRole('button', { name: 'Send' });
  assert.equal(await send.isDisabled(), true);
  await box.fill('Hello');
  await box.press('Shift+Enter');
  await box.type('there ');
  await box.press('Enter');
  await settle(p);
  assert.deepEqual(await events(), [['send', 'Hello\nthere']]);
  assert.equal(await box.inputValue(), '');
  const emoji = p.getByRole('button', { name: 'Insert emoji' });
  await emoji.click();
  await settle(p);
  assert.equal(await emoji.getAttribute('aria-expanded'), 'true');
  await p.getByRole('group', { name: 'Emoji' }).getByRole('button', { name: '🎉' }).click();
  await settle(p);
  assert.equal(await box.inputValue(), '🎉');
  await done(p, messages);
});

test('modal-dialog: a labelled modal; focus goes in and comes back; Escape and the backdrop close it', async () => {
  const { page: p, messages, events } = await page('modal-dialog', `
    <button id="opener" onclick="document.querySelector('modal-dialog').open = true">Open</button>
    <modal-dialog label="Delete event?"><p>This can't be undone.</p><button slot="actions">Delete</button></modal-dialog>`, ['openchange']);
  await p.click('#opener');
  await settle(p);
  const dialog = p.getByRole('dialog', { name: 'Delete event?' });
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await p.evaluate(() => !!document.activeElement.closest('dialog')), true, 'focus is in the dialog');
  await p.keyboard.press('Escape');
  await settle(p);
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await p.evaluate(() => document.activeElement.id), 'opener', 'focus returns');
  assert.deepEqual(await events(), [['openchange', false]]);

  await p.click('#opener');
  await settle(p);
  await p.mouse.click(5, 5); // the backdrop
  await settle(p);
  assert.equal(await dialog.isVisible(), false);
  await p.click('#opener');
  await settle(p);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await settle(p);
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await p.locator('modal-dialog footer').count(), 1, 'actions given');
  await done(p, messages);
});
