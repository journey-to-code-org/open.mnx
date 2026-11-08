// The help desk in Chromium, twice over: with JavaScript off, where everything is server-rendered
// HTML and native forms, and with it on, where the same markup is hydrated by the zubra elements,
// which add keyboard navigation, live filters, a smarter reply box and running SLA timers.
// Uses MongoDB when MONGODB_URI is set (CI), and the in-memory store otherwise.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createApp } from '../src/app.js';
import { createStore } from '../src/store/index.js';
import { shot } from '../../../demos/shot.js';

let store, server, base, browser;
before(async () => {
  store = await createStore(process.env.MONGODB_URI ? `${process.env.MONGODB_URI.replace(/\/$/, '')}/helpdesk-app-test` : undefined);
  server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
  await store?.close();
});
beforeEach(() => store.reset());

/** A page signed in as `user`, with or without JavaScript, collecting errors and warnings. */
async function as(user, { js = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: js });
  const page = await context.newPage();
  const messages = [];
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(error.message));
  await page.goto(`${base}/login`);
  await page.click(`button[value=${user}]`);
  await page.waitForURL(`${base}/`);
  return { page, messages, close: () => context.close() };
}
const text = (page, selector) => page.locator(selector).evaluateAll((els) => els.map((el) => el.textContent.trim().replace(/\s+/g, ' ')));
const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  await Promise.all([...document.querySelectorAll('*')].filter((el) => el.updateComplete).map((el) => el.updateComplete));
});

test('without JavaScript: sign in, file a ticket (with validation), reply, filter; customers see only their own', async () => {
  const { page, messages, close } = await as('u-lena', { js: false });
  assert.deepEqual(await text(page, 'h1'), ['Your tickets']);
  const mine = await text(page, 'ticket-table td:nth-child(5)');
  assert.ok(mine.length > 0 && mine.every((name) => name === 'Lena Vogel'), 'only her tickets');
  assert.ok((await text(page, 'ticket-table sla-timer')).every((label) => /^(due in|overdue by|met)/.test(label)), 'SLA text rendered on the server');

  // The form is native HTML: errors come back from the server, with what was typed.
  await page.goto(`${base}/tickets/new`);
  await page.fill('input[name=subject]', 'Hi');
  await page.click('button:has-text("Create ticket")');
  assert.equal(await page.locator('#subject-error').textContent(), 'Give the ticket a subject of at least 5 characters.');
  assert.equal(await page.inputValue('input[name=subject]'), 'Hi');
  assert.match(await page.textContent('.error >> nth=1'), /Describe the problem/);

  await page.fill('input[name=subject]', 'Reports page times out');
  await page.check('priority-picker input[value=high]'); // a native radio inside the zubra element
  await page.fill('textarea[name=body]', 'The monthly report never finishes loading.');
  await page.click('button:has-text("Create ticket")');
  await page.waitForURL(/\/tickets\/1013$/);
  assert.equal(await page.textContent('h1'), 'Reports page times out');
  assert.equal(await page.textContent('.meta .priority'), 'high');
  assert.match((await page.textContent('.meta sla-timer')).trim(), /^due in (7h 59m|8h 0m)$/);

  // Replying: a native textarea and button inside reply-composer.
  await page.fill('reply-composer textarea', 'It also happens on the weekly report.');
  await page.click('reply-composer button');
  await page.waitForURL(/\/tickets\/1013#latest$/);
  assert.deepEqual((await text(page, 'ticket-thread li p')).at(-1), 'It also happens on the weekly report.');
  assert.equal(await page.locator('reply-composer input[name=internal]').count(), 0, 'no internal notes for customers');

  // Filters are a GET form: Apply is there, and the URL is shareable.
  await page.goto(`${base}/tickets`);
  await page.selectOption('filter-bar select[name=status]', 'solved');
  await page.click('filter-bar .apply');
  await page.waitForURL(/status=solved/);
  assert.ok((await text(page, 'ticket-table status-badge')).every((status) => status === 'solved'));

  // Someone else's ticket isn't there for her, and agent actions are refused.
  assert.equal((await page.goto(`${base}/tickets/1002`)).status(), 404);
  const update = await page.request.post(`${base}/tickets/1001`, { form: { status: 'solved' } });
  assert.equal(update.status(), 403);
  assert.deepEqual(messages.filter((message) => !/status of (403|404|422)/.test(message)), [], 'no errors but the ones asked for');
  await close();
});

test('with JavaScript: the server markup is hydrated in place, then J/K/Enter, live filters and the reply box work', async () => {
  const { page, messages, close } = await as('u-ada');
  // Record the first row as the HTML parser makes it; after hydration it must be the same node.
  await page.addInitScript(() => {
    new MutationObserver((records, observer) => {
      const row = document.querySelector('ticket-table tr[data-id]');
      if (row) { window.parsedRow = row; observer.disconnect(); }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${base}/tickets`);
  await settle(page);
  assert.equal(await page.evaluate(() => window.parsedRow === document.querySelector('ticket-table tr[data-id]')), true, 'hydrated, not re-rendered');
  assert.equal(await page.isVisible('filter-bar .apply'), false, 'Apply is gone: filters apply as you choose them');
  assert.equal(await page.isVisible('ticket-table .keys'), true);

  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await settle(page);
  const second = await page.getAttribute('ticket-table tr.active', 'data-id');
  assert.equal(second, await page.getAttribute('ticket-table tbody tr >> nth=1', 'data-id'));
  await page.keyboard.press('k');
  await settle(page);
  assert.equal(await page.getAttribute('ticket-table tr.active', 'data-id'), await page.getAttribute('ticket-table tbody tr >> nth=0', 'data-id'));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/tickets\/\d+$/);

  await page.goto(`${base}/tickets`);
  await page.selectOption('filter-bar select[name=priority]', 'urgent');
  await page.waitForURL(/priority=urgent/);
  assert.deepEqual([...new Set(await text(page, 'ticket-table td.priority'))], ['urgent']);

  // The reply box: Send waits for text, counts, and Ctrl+Enter sends. Internal notes stay inside.
  await page.goto(`${base}/tickets/1001`);
  await settle(page);
  assert.equal(await page.isDisabled('reply-composer button'), true);
  await page.fill('reply-composer textarea', 'Found it: a Safari-only CSS bug.');
  await settle(page);
  assert.equal(await page.textContent('reply-composer .count'), '32/4000');
  await page.check('reply-composer input[name=internal]');
  await page.press('reply-composer textarea', 'Control+Enter');
  await page.waitForURL(/#latest$/);
  assert.deepEqual((await text(page, 'ticket-thread li.internal p')), ['Found it: a Safari-only CSS bug.']);

  // The priority picker highlights as it changes, and the update form saves it.
  await page.click('aside priority-picker label[data-level=high]');
  await settle(page);
  assert.deepEqual(await text(page, 'aside priority-picker label.checked'), ['high']);
  await page.selectOption('aside select[name=status]', 'pending');
  await page.click('aside button');
  await page.waitForURL(/updated=1$/);
  assert.equal(await page.textContent('.meta .priority'), 'high');
  assert.equal(await page.textContent('.meta status-badge'), 'pending');
  assert.deepEqual(messages, []);
  await close();

  // The customer doesn't see the internal note.
  const customer = await as('u-lena');
  await customer.page.goto(`${base}/tickets/1001`);
  assert.deepEqual(await text(customer.page, 'ticket-thread li.internal'), []);
  assert.ok(!(await customer.page.content()).includes('Safari-only CSS bug'));
  await customer.close();
});

test('the SLA timer keeps counting in the browser', async () => {
  const { page, messages, close } = await as('u-ada');
  await page.clock.install({ time: Date.now() });
  await page.goto(`${base}/tickets/1001`);
  await settle(page);
  const before = (await page.textContent('.meta sla-timer')).trim();
  assert.match(before, /^due in (\d+m|1h \d+m)$/);
  await page.clock.fastForward('02:00:00');
  await settle(page);
  const later = (await page.textContent('.meta sla-timer')).trim();
  assert.match(later, /^overdue by/, `${before} → ${later}`);
  assert.equal(await page.getAttribute('.meta sla-timer time', 'class'), 'overdue');
  assert.deepEqual(messages, []);
  await close();
});

test('the dashboard: counts, and the registry charts hydrated with the server data', async () => {
  const { page, messages, close } = await as('u-sam');
  await settle(page);
  assert.deepEqual(await text(page, '.card span'), ['Open', 'Pending', 'Solved', 'Overdue']);
  await shot(page, 'helpdesk');
  assert.deepEqual(await text(page, 'donut-chart li button span:nth-child(2)'), ['Open', 'Pending', 'Solved']);
  assert.equal(await page.getByRole('img', { name: 'Tickets by status' }).count(), 1);
  assert.match(await page.getByRole('img', { name: /^New tickets per day: / }).getAttribute('aria-label'), /: (up|down|flat)$/);
  // Only the queue's tickets: open or pending, Sam's or nobody's.
  const assignees = await text(page, 'ticket-table td:nth-child(6)');
  assert.ok(assignees.length > 0 && assignees.every((name) => name === 'Sam Okafor' || name === 'Unassigned'));
  assert.deepEqual(messages, []);
  await close();
});

test('the dashboard\'s charts are in the server\'s HTML: the registry components\' JavaScript ran on the server', async () => {
  const { page, close } = await as('u-sam', { js: false });
  // donut-chart's reduce/filter/Math.round and spark-line's map/join: rendered, not left empty.
  assert.deepEqual(await text(page, 'donut-chart li button span:nth-child(2)'), ['Open', 'Pending', 'Solved']);
  assert.ok((await page.locator('donut-chart circle[data-label]').count()) >= 1);
  assert.match(await page.locator('donut-chart .pct').first().textContent(), /^\d+%$/);
  assert.match(await page.getByRole('img', { name: /^New tickets per day: / }).getAttribute('aria-label'), /: (up|down|flat)$/);
  assert.match(await page.locator('spark-line polyline').getAttribute('points'), /^[\d.]+,[\d.]+( [\d.]+,[\d.]+)+$/);
  // Nothing is left for the browser: the one pending region, the streamed activity list, is put
  // in place by the browser itself (out-of-order streaming, Chromium 150+), without JavaScript.
  assert.equal(await page.evaluate(() => document.body.innerHTML.split('<?zb [??>').length - 1), 0, 'nothing left for the browser');
  assert.equal(await page.locator('recent-activity .pending').count(), 0);
  assert.ok((await page.locator('recent-activity li .who').count()) >= 3, 'the streamed list, without the swap script');
  await close();
});

test('the dashboard streams its recent activity: the page first, the list as the store answers, hydrated in place', async () => {
  // The raw response: the whole page (through </html>) comes before the streamed region.
  const { page, messages, close } = await as('u-sam');
  const html = await page.evaluate(async () => (await fetch('/')).text());
  const shellEnd = html.indexOf('</html>');
  const swap = html.indexOf('<template for=');
  assert.ok(shellEnd > 0 && swap > shellEnd, 'the shell, then the swap');
  assert.match(html.slice(0, shellEnd), /<recent-activity data-zb-stream="0"[^>]*>[^]*<\?start name="zb-0-0"\?><\?zb \[\?\?>[^]*Loading recent activity…/);
  assert.match(html.slice(swap), /<li><span class="who">[^<]+<\/span><a href="\/tickets\/\d+">/);
  // In the browser: the list is there and hydrated, with no warnings.
  await settle(page);
  await page.waitForFunction(() => document.querySelector('recent-activity')?.matches(':state(hydrated)'));
  const items = await text(page, 'recent-activity li .who');
  assert.ok(items.length >= 3 && items.length <= 8, `${items.length} recent messages`);
  assert.equal(await page.locator('recent-activity .pending').count(), 0);
  assert.deepEqual(messages, []);
  await close();
});
