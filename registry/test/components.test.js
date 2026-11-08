// The registry's components in Chromium: each is found by its role and accessible name (what a
// screen reader announces), works from the keyboard, and fires its events. They're compiled by
// the CLI and served with the runtime, as in runtime/test/browser. `node --test registry/test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useBrowser, open } from '../../runtime/test/browser/harness.js';
import * as zag from './zag.js';

const here = dirname(fileURLToPath(import.meta.url));
const names = readdirSync(join(here, '../components')).filter((file) => file.endsWith('.zb')).map((file) => file.slice(0, -3));

useBrowser(Object.fromEntries(names.map((name) => [name, join(here, '../components', `${name}.zb`)])), zag.files, zag.imports);

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
  assert.equal(names.length, 25);
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

// ---- accessible widgets ---------------------------------------------------------------------

test('accordion-panel: native disclosure from the keyboard; one open at a time in a group', async () => {
  const { page: p, messages, events } = await page('accordion-panel', `
    <accordion-panel heading="Shipping" group="faq"><p>Two days.</p></accordion-panel>
    <accordion-panel heading="Returns" group="faq" open><p>Thirty days.</p></accordion-panel>`, ['openchange']);
  const shipping = p.locator('summary', { hasText: 'Shipping' });
  assert.equal(await p.getByText('Thirty days.').isVisible(), true);
  await shipping.focus();
  await p.keyboard.press('Enter');
  await settle(p);
  assert.equal(await p.getByText('Two days.').isVisible(), true);
  assert.equal(await p.getByText('Thirty days.').isVisible(), false, 'the other closed');
  assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('accordion-panel')].map((panel) => panel.open)), [true, false]);
  assert.deepEqual((await events()).map(([type, detail]) => `${type}:${detail}`).sort(), ['openchange:false', 'openchange:true']);
  await p.keyboard.press(' ');
  await settle(p);
  assert.equal(await p.getByText('Two days.').isVisible(), false);
  await done(p, messages);
});

test('tool-tip: describes its trigger; shows on focus and hover, Escape hides it', async () => {
  const { page: p, messages } = await page('tool-tip', '<tool-tip text="Copy the link" delay="0"><button>Copy</button></tool-tip>');
  const button = p.getByRole('button', { name: 'Copy' });
  const tip = p.getByRole('tooltip');
  assert.equal(await p.evaluate(() => document.getElementById(document.querySelector('button').getAttribute('aria-describedby')).textContent), 'Copy the link');
  assert.equal(await tip.isVisible(), false);
  await button.focus();
  await p.waitForTimeout(30);
  assert.equal(await tip.isVisible(), true);
  assert.equal(await tip.textContent(), 'Copy the link');
  const [trigger, own] = await p.evaluate(() => [document.querySelector('button'), document.querySelector('[role=tooltip]')].map((el) => el.getBoundingClientRect().toJSON()));
  assert.ok(own.bottom <= trigger.top + 1 || own.top >= trigger.bottom - 1, 'placed beside the trigger, not over it');
  await p.keyboard.press('Escape');
  assert.equal(await tip.isVisible(), false);
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Copy', 'focus stays');
  await p.evaluate(() => document.activeElement.blur());
  await button.hover();
  await p.waitForTimeout(30);
  assert.equal(await tip.isVisible(), true);
  await p.mouse.move(400, 400);
  await p.waitForTimeout(30);
  assert.equal(await tip.isVisible(), false);
  await done(p, messages);
});

test('tab-list: one tab stop; arrows choose (or only move, when manual); panels labelled and hidden', async () => {
  const body = (manual) => `
    <tab-list label="Account" ${manual ? 'manual' : ''}>
      <section data-tab="profile">Profile form</section>
      <section data-tab="billing">Billing form</section>
      <section data-tab="team">Team list</section>
    </tab-list>`;
  const tabs = [{ value: 'profile', label: 'Profile' }, { value: 'billing', label: 'Billing' }, { value: 'team', label: 'Team' }];
  const { page: p, messages, events } = await page('tab-list', body(false), ['valuechange']);
  await p.evaluate((tabs) => { document.querySelector('tab-list').tabs = tabs; }, tabs);
  await settle(p);
  const list = p.getByRole('tablist', { name: 'Account' });
  assert.equal(await list.getByRole('tab', { name: 'Profile' }).getAttribute('aria-selected'), 'true');
  assert.equal(await p.getByRole('tabpanel', { name: 'Profile' }).textContent(), 'Profile form');
  assert.equal(await p.getByText('Billing form').isVisible(), false);
  await p.keyboard.press('Tab');
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Profile');
  await p.keyboard.press('ArrowRight');
  await settle(p);
  assert.equal(await list.getByRole('tab', { name: 'Billing' }).getAttribute('aria-selected'), 'true');
  assert.equal(await p.getByRole('tabpanel', { name: 'Billing' }).isVisible(), true);
  await p.keyboard.press('End');
  await p.keyboard.press('ArrowRight'); // loops
  await settle(p);
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Profile');
  assert.deepEqual(await events(), [['valuechange', 'billing'], ['valuechange', 'team'], ['valuechange', 'profile']]);
  await p.keyboard.press('Tab');
  assert.equal(await p.evaluate(() => document.activeElement.getAttribute('role')), 'tabpanel', 'Tab leaves the list for the panel');
  await done(p, messages);

  const manual = await page('tab-list', body(true), ['valuechange']);
  await manual.page.evaluate((tabs) => { document.querySelector('tab-list').tabs = tabs; }, tabs);
  await settle(manual.page);
  await manual.page.keyboard.press('Tab');
  await manual.page.keyboard.press('ArrowRight');
  await settle(manual.page);
  assert.deepEqual(await manual.events(), [], 'moving doesn\'t choose');
  await manual.page.keyboard.press('Enter');
  await settle(manual.page);
  assert.deepEqual(await manual.events(), [['valuechange', 'billing']]);
  await done(manual.page, manual.messages);
});

test('dropdown-menu: a menu button; arrows and typing move; picking returns focus; Escape closes', async () => {
  const { page: p, messages, events } = await page('dropdown-menu', '<dropdown-menu label="Actions"></dropdown-menu><button id="after">After</button>', ['itemselect']);
  await p.evaluate(() => { document.querySelector('dropdown-menu').items = [{ value: 'edit', label: 'Edit' }, { value: 'copy', label: 'Duplicate' }, { value: 'archive', label: 'Archive', disabled: true }, { value: 'delete', label: 'Delete' }]; });
  await settle(p);
  const button = p.getByRole('button', { name: 'Actions' });
  assert.equal(await button.getAttribute('aria-haspopup'), 'menu');
  await button.focus();
  await p.keyboard.press('ArrowDown');
  await settle(p);
  const menu = p.getByRole('menu', { name: 'Actions' });
  assert.equal(await menu.isVisible(), true);
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  const focused = () => p.evaluate(() => document.activeElement.textContent);
  assert.equal(await focused(), 'Edit');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('ArrowDown'); // skips the disabled item
  assert.equal(await focused(), 'Delete');
  await p.keyboard.press('e'); // typeahead
  assert.equal(await focused(), 'Edit');
  await p.keyboard.press('ArrowUp'); // loops
  assert.equal(await focused(), 'Delete');
  await p.keyboard.press('Enter');
  await settle(p);
  assert.equal(await menu.isVisible(), false);
  assert.equal(await focused(), 'Actions', 'focus returns');
  assert.deepEqual(await events(), [['itemselect', 'delete']]);

  await p.keyboard.press('ArrowUp'); // opens at the last item
  await settle(p);
  assert.equal(await focused(), 'Delete');
  await p.keyboard.press('Escape');
  await settle(p);
  assert.equal(await menu.isVisible(), false);
  assert.equal(await focused(), 'Actions');
  assert.equal(await button.getAttribute('aria-expanded'), 'false');

  await p.keyboard.press('Enter'); // the button toggles it, as any popover button
  await settle(p);
  assert.equal(await menu.isVisible(), true);
  const [anchor, own] = await p.evaluate(() => [document.querySelector('.trigger'), document.querySelector('[role=menu]')].map((el) => el.getBoundingClientRect().toJSON()));
  assert.ok(own.top >= anchor.bottom - 1, 'below the button');
  await p.keyboard.press('Tab');
  await settle(p);
  assert.equal(await menu.isVisible(), false, 'Tab closes it');
  await done(p, messages);
});

test('combo-box (Zag): a labelled combobox; typing filters, arrows and Enter pick; a form value', async () => {
  const { page: p, messages, events } = await page('combo-box', '<form><combo-box name="fruit" label="Fruit"></combo-box></form>', ['valuechange']);
  await p.evaluate(() => { document.querySelector('combo-box').items = [{ value: 'apple', label: 'Apple' }, { value: 'banana', label: 'Banana' }, { value: 'blueberry', label: 'Blueberry' }]; });
  await settle(p);
  const field = p.getByRole('combobox', { name: 'Fruit' });
  await field.click();
  await field.pressSequentially('b');
  await settle(p);
  const listbox = p.getByRole('listbox');
  assert.equal(await listbox.isVisible(), true);
  assert.deepEqual(await listbox.getByRole('option').allTextContents(), ['Banana', 'Blueberry']);
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  await settle(p);
  assert.equal(await field.inputValue(), 'Blueberry');
  assert.deepEqual(await events(), [['valuechange', 'blueberry']]);
  assert.equal((await formData(p)).fruit, 'blueberry');
  await done(p, messages);
});
