// The example projects in examples/, built the way their READMEs say and used in Chromium, so
// they keep working as mnx changes. Each is copied inside plugin/ to resolve its packages from
// here (their own package.json points at the repository's packages). `npm test` in plugin/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const work = join(here, '.tmp-examples');
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;
const servers = [];

before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  // The CLI, unless the WebAssembly build is there.
  process.env.MNX_COMPILER ??= join(repo, 'target/debug/mnx');
  rmSync(work, { recursive: true, force: true });
  // What `npm install` gives an example: the plugin itself, next to the packages it uses.
  mkdirSync(join(work, 'node_modules/@mnx'), { recursive: true });
  symlinkSync(join(here, '..'), join(work, 'node_modules/@mnx/unplugin'), 'dir');
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.close();
  rmSync(work, { recursive: true, force: true });
});

function copy(name) {
  const root = join(work, name);
  cpSync(join(repo, 'examples', name), root, { recursive: true, filter: (path) => !/[\\/](node_modules|dist|\.astro)([\\/]|$)/.test(path) });
  return root;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

async function serve(dir) {
  const server = createServer((request, response) => {
    let path = join(dir, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    try {
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain' }).end(readFileSync(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function open(url) {
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto(url);
  return { page, messages };
}

const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const all = (root) => [...root.querySelectorAll('*')].flatMap((el) => [el, ...(el.shadowRoot ? all(el.shadowRoot) : [])]);
  await Promise.all(all(document).filter((el) => el.localName.includes('-') && el.updateComplete).map((el) => el.updateComplete));
});

test('todo: add, complete, edit, filter, clear, and keep the list across reloads', async () => {
  const { build } = await import('vite');
  const root = copy('todo');
  await build({ root, configFile: join(root, 'vite.config.js'), configLoader: 'native', logLevel: 'silent' });
  const { page, messages } = await open(await serve(join(root, 'dist')));
  await page.waitForFunction(() => window.ready);
  await settle(page);
  const items = () => page.$$eval('todo-app todo-item', (els) => els.map((el) => `${el.done ? 'x' : ' '} ${el.text}`));
  const count = () => page.textContent('todo-app .count');
  assert.deepEqual(await items(), ['x Try mnx 2.0', '  Write a component']);
  assert.equal(await count(), '1 left');

  await page.fill('todo-app form input', 'Ship it');
  await page.press('todo-app form input', 'Enter');
  await settle(page);
  assert.deepEqual(await items(), ['x Try mnx 2.0', '  Write a component', '  Ship it']);
  assert.equal(await page.inputValue('todo-app form input'), '', 'the field cleared');
  assert.equal(await count(), '2 left');

  await page.locator('todo-item').nth(1).locator('input[type=checkbox]').click();
  await settle(page);
  assert.equal(await count(), '1 left');

  await page.locator('todo-item').nth(2).locator('span').dblclick();
  await settle(page);
  const edit = page.locator('todo-item').nth(2).locator('input.edit, input[aria-label="Edit item"]');
  await edit.fill('Ship 2.0');
  await edit.press('Enter');
  await settle(page);
  assert.deepEqual(await items(), ['x Try mnx 2.0', 'x Write a component', '  Ship 2.0']);

  await page.click('todo-app footer button:has-text("Open")');
  await settle(page);
  assert.deepEqual(await items(), ['  Ship 2.0']);
  await page.click('todo-app footer button:has-text("All")');
  await page.click('todo-app footer button:has-text("Clear done")');
  await settle(page);
  assert.deepEqual(await items(), ['  Ship 2.0']);

  await page.reload();
  await page.waitForFunction(() => window.ready);
  await settle(page);
  assert.deepEqual(await items(), ['  Ship 2.0'], 'saved in localStorage');
  assert.deepEqual(messages, []);
  await page.close();
});

test('recipes (Astro): static pages, a JSX island, a form-associated control, loaded reviews', async () => {
  const { build } = await import('astro');
  const root = copy('recipes');
  await build({ root, logLevel: 'error' });
  const dist = join(root, 'dist');

  // The index is server-rendered cards: HTML and CSS only.
  const index = readFileSync(join(dist, 'index.html'), 'utf8');
  assert.match(index, /<recipe-card[^>]*heading="Shakshuka"[^>]*>\s*<a href="\/recipes\/shakshuka\/">\s*<h2>Shakshuka<\/h2>/);
  assert.match(index, /<span class="tag"[^>]*>one pan<\/span>/, 'slot content');
  assert.doesNotMatch(index, /<script/, 'no JavaScript on the index');
  // The islands are server-rendered: markup that only depends on props is there before any
  // JavaScript runs; what state computes (the amounts, the reviews) is filled in when it hydrates.
  const page = readFileSync(join(dist, 'recipes/shakshuka/index.html'), 'utf8');
  assert.match(page, /<recipe-servings[^>]*>[^]*<li><b><\/b><!----> chopped tomatoes<\/li>/);
  assert.match(page, /<recipe-reviews[^>]*>[^]*<p class="loading">Loading reviews…<\/p>/);

  const url = await serve(dist);
  const { page: tab, messages } = await open(`${url}/`);
  assert.equal(await tab.$$eval('recipe-card h2', (els) => els.map((el) => el.textContent).join(', ')), 'Shakshuka, Red lentil dal, Yogurt flatbreads');
  assert.equal(await tab.$eval('recipe-card', (el) => el.matches(':defined')), false, 'the cards stay HTML');
  await tab.click('recipe-card >> text=Shakshuka');
  await tab.waitForURL(/\/recipes\/shakshuka\/$/);
  await tab.waitForFunction(() => customElements.get('recipe-servings'));
  await settle(tab);

  // Servings: a JSX component with state and derived amounts.
  const amounts = () => tab.$$eval('recipe-servings li b', (els) => els.slice(0, 3).map((el) => el.textContent));
  assert.deepEqual(await amounts(), ['4', '400 g', '1']);
  await tab.click('recipe-servings .more');
  await settle(tab);
  assert.equal(await tab.textContent('recipe-servings output'), '3');
  assert.deepEqual(await amounts(), ['6', '600 g', '1.5']);
  await tab.click('recipe-servings .fewer');
  await tab.click('recipe-servings .fewer');
  await settle(tab);
  assert.deepEqual(await amounts(), ['2', '200 g', '0.5']);
  assert.equal(await tab.$eval('recipe-servings .fewer', (el) => el.disabled), true, 'one serving at least');

  // Reviews: hydrated when visible, then loaded with resource() into <mnx-await>.
  await tab.locator('recipe-reviews').scrollIntoViewIfNeeded();
  await tab.waitForSelector('recipe-reviews li');
  await settle(tab);
  const reviews = () => tab.$$eval('recipe-reviews li', (els) => els.map((el) => `${el.querySelector('strong').textContent} ${el.querySelector('star-rating').value}`));
  assert.deepEqual(await reviews(), ['Ada 5', 'Grace 4']);
  assert.equal(await tab.textContent('recipe-reviews .average'), '4.5 ★ from 2');

  // The form: <star-rating> is a form control, required, so the form won't submit without it.
  const form = tab.locator('recipe-reviews form');
  await form.locator('input[name=name]').fill('Linus');
  await form.locator('textarea').fill('Great with flatbreads.');
  assert.equal(await form.evaluate((el) => el.checkValidity()), false, 'a rating is required');
  await form.locator('star-rating button').nth(2).click();
  await settle(tab);
  assert.equal(await form.evaluate((el) => new FormData(el).get('stars')), '3', 'it submits its value');
  await form.locator('button[type=submit]').click();
  await settle(tab);
  assert.deepEqual(await reviews(), ['Linus 3', 'Ada 5', 'Grace 4']);
  assert.equal(await tab.textContent('recipe-reviews .average'), '4.0 ★ from 3');
  assert.equal(await form.locator('input[name=name]').inputValue(), '', 'the form reset');
  assert.equal(await form.locator('star-rating').evaluate((el) => el.value), 0, 'and so did the rating');

  // A recipe with no reviews yet.
  await tab.goto(`${url}/recipes/flatbreads/`);
  await tab.locator('recipe-reviews').scrollIntoViewIfNeeded();
  await tab.waitForSelector('recipe-reviews .empty');
  assert.equal(await tab.textContent('recipe-reviews .average'), 'none yet');
  assert.deepEqual(messages, []);
  await tab.close();
});

test('planner: calendar, events, a dialog form, guests, budget, schedule, tasks, export, persistence', async () => {
  const { build } = await import('vite');
  const root = copy('planner');
  await build({ root, configFile: join(root, 'vite.config.js'), configLoader: 'native', logLevel: 'silent' });
  const url = await serve(join(root, 'dist'));
  const { page, messages } = await open(`${url}/`);
  await page.waitForSelector('month-calendar td');
  await settle(page);
  const texts = (selector) => page.$$eval(selector, (els) => els.map((el) => el.textContent.trim().replace(/\s+/g, ' ')));
  const day = (n) => page.evaluate((n) => {
    const date = new Date();
    date.setDate(date.getDate() + n);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }, n);
  const go = async (selector) => { await page.click(selector); await settle(page); };

  // Home: the sample events, on the calendar (which may need the next month) and in the list.
  assert.deepEqual(await texts('upcoming-list li strong'), ['Launch party', 'Quarterly planning']);
  await go('upcoming-list button.pill >> text=Past');
  assert.deepEqual(await texts('upcoming-list li strong'), ['Weekend in the mountains']);
  await go('upcoming-list button.pill >> text=Upcoming');
  await page.fill('upcoming-list input[type=search]', 'quarter');
  await settle(page);
  assert.deepEqual(await texts('upcoming-list li strong'), ['Quarterly planning']);
  await page.fill('upcoming-list input[type=search]', 'nothing like this');
  await settle(page);
  assert.equal(await page.textContent('upcoming-list .empty'), 'No events match.');
  await page.fill('upcoming-list input[type=search]', '');
  await page.selectOption('upcoming-list select', 'work');
  await settle(page);
  assert.deepEqual(await texts('upcoming-list li strong'), ['Quarterly planning']);
  await page.selectOption('upcoming-list select', 'all');
  const month = await page.textContent('month-calendar h2');
  await go('month-calendar button.next');
  assert.notEqual(await page.textContent('month-calendar h2'), month);
  await go('month-calendar button.today-button');
  assert.equal(await page.textContent('month-calendar h2'), month);
  const launch = await day(3);
  if (!(await page.$(`month-calendar td[data-day="${launch}"]`))) await go('month-calendar button.next');
  assert.match(await page.textContent(`month-calendar td[data-day="${launch}"] a`), /19:00 Launch party/);
  await go('month-calendar button.today-button');

  // A new event from a day on the calendar: the dialog starts on that day and checks the times.
  const tomorrow = await day(1);
  if (!(await page.$(`month-calendar td[data-day="${tomorrow}"]`))) await go('month-calendar button.next');
  await go(`month-calendar td[data-day="${tomorrow}"] .day`);
  const dialog = page.locator('event-dialog dialog');
  assert.equal(await dialog.evaluate((el) => el.open), true);
  assert.equal(await dialog.locator('h2').textContent(), 'New event');
  assert.equal(await dialog.locator('input[name=day]').inputValue(), tomorrow);
  await dialog.locator('input[name=title]').fill('Board games');
  await dialog.locator('input[name=start]').fill('18:00');
  await dialog.locator('input[name=end]').fill('17:00');
  await dialog.locator('button[type=submit]').click();
  await settle(page);
  assert.equal(await dialog.locator('.problem').textContent(), 'Ends before it starts');
  await dialog.locator('input[name=end]').fill('22:00');
  await dialog.locator('input[name=location]').fill('My place');
  await dialog.locator('button[type=submit]').click();
  await settle(page);
  assert.equal(await dialog.evaluate((el) => el.open), false);
  assert.match(page.url(), /#\/events\/e\w+$/);
  assert.equal(await page.textContent('event-page h1'), 'Board games');
  assert.match(await page.textContent('event-page .meta'), /\(tomorrow\) · 18:00–22:00 · My place/);

  // Guests: invite, refuse a duplicate, RSVP and plus-ones make the headcount.
  await go('event-page [data-tab=guests]');
  assert.equal(await page.textContent('guest-list .empty'), 'No guests yet.');
  await page.fill('guest-list input[aria-label="Guest name"]', 'Lin');
  await page.fill('guest-list input[aria-label="Guest email"]', 'lin@example.com');
  await go('guest-list button[type=submit]');
  await page.fill('guest-list input[aria-label="Guest name"]', 'Lin again');
  await page.fill('guest-list input[aria-label="Guest email"]', 'LIN@example.com');
  await go('guest-list button[type=submit]');
  assert.equal(await page.textContent('guest-list .problem'), 'lin@example.com is already invited');
  await page.fill('guest-list input[aria-label="Guest email"]', 'sam@example.com');
  await page.fill('guest-list input[aria-label="Guest name"]', 'Sam');
  assert.equal(await page.$('guest-list .problem'), null, 'typing clears the problem');
  await go('guest-list button[type=submit]');
  assert.deepEqual(await texts('guest-list tbody td:first-child'), ['Linlin@example.com', 'Samsam@example.com']);
  await page.selectOption('guest-list select[aria-label="RSVP for Lin"]', 'yes');
  await settle(page);
  await go('guest-list input[aria-label="Lin brings a plus-one"]');
  await page.selectOption('guest-list select[aria-label="RSVP for Sam"]', 'no');
  await settle(page);
  assert.equal(await page.textContent('guest-list .headcount'), 'Headcount: 2');
  assert.equal(await page.textContent('event-page b.going'), '2');
  await go('guest-list button[data-filter=no]');
  assert.deepEqual(await texts('guest-list tbody td:first-child'), ['Samsam@example.com']);
  assert.equal(await page.inputValue('guest-list select'), 'no', 'a select shows its bound value');
  await go('guest-list button[aria-label="Remove Sam"]');
  assert.equal(await page.textContent('guest-list .empty'), 'No one with that RSVP.');

  // Budget: set one in the dialog, then go over it.
  await go('event-page button.edit');
  assert.equal(await dialog.locator('h2').textContent(), 'Edit event');
  assert.equal(await dialog.locator('input[name=title]').inputValue(), 'Board games');
  await dialog.locator('input[name=title]').fill('Not saved');
  await page.keyboard.press('Escape');
  await settle(page);
  await go('event-page button.edit');
  assert.equal(await dialog.locator('input[name=title]').inputValue(), 'Board games', 'a cancelled edit is forgotten');
  await dialog.locator('input[name=budget]').fill('50');
  await dialog.locator('button[type=submit]').click();
  await settle(page);
  await go('event-page [data-tab=budget]');
  await page.fill('budget-table input[aria-label=Expense]', 'Snacks');
  await page.fill('budget-table input[aria-label=Amount]', '35.5');
  await go('budget-table button[type=submit]');
  assert.equal(await page.textContent('budget-table b.left'), '$14.50');
  await page.fill('budget-table input[aria-label=Expense]', 'New game');
  await page.selectOption('budget-table select', 'other');
  await page.fill('budget-table input[aria-label=Amount]', '44.5');
  await go('budget-table button[type=submit]');
  assert.equal(await page.textContent('budget-table b.left'), '-$30.00');
  assert.equal(await page.$eval('budget-table .totals', (el) => el.classList.contains('over')), true);
  assert.deepEqual(await texts('budget-table tbody td:nth-child(2)'), ['food', 'other']);
  await go('budget-table input[aria-label="Snacks is paid"]');
  assert.equal(await page.textContent('budget-table b.spent + span'), '$35.50 paid');
  assert.equal(await page.textContent('event-page b.spent'), '$80.00');

  // Schedule: sorted by time, with warnings.
  await go('event-page [data-tab=schedule]');
  for (const [time, title] of [['20:00', 'Second game'], ['18:30', 'First game'], ['23:30', 'One more'], ['20:00', 'Pizza']]) {
    await page.fill('schedule-list input[type=time]', time);
    await page.fill('schedule-list input[aria-label="What happens"]', title);
    await go('schedule-list button[type=submit]');
  }
  assert.deepEqual(await texts('schedule-list li time'), ['18:30', '20:00', '20:00', '23:30']);
  assert.deepEqual(await texts('schedule-list .warn'), ['Same time as another item', 'Same time as another item', "Outside the event's hours"]);
  await go('schedule-list button[aria-label="Remove Pizza"]');
  assert.deepEqual(await texts('schedule-list .warn'), ["Outside the event's hours"]);

  // Tasks.
  await go('event-page [data-tab=tasks]');
  for (const title of ['Pick games', 'Buy snacks']) {
    await page.fill('task-list input[aria-label="Add a task"]', title);
    await go('task-list button[type=submit]');
  }
  await go('task-list li:first-child input[type=checkbox]');
  assert.equal(await page.textContent('task-list .progress-label'), '1 of 2 done');
  assert.equal(await page.textContent('event-page b.done'), '1/2');
  await go('task-list input.hide-done');
  assert.deepEqual(await texts('task-list li span'), ['Buy snacks']);
  await go('task-list input.hide-done');
  await go('task-list button.clear-done');
  assert.deepEqual(await texts('task-list li span'), ['Buy snacks']);

  // Export as an iCalendar file.
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('event-page button.export')]);
  assert.equal(download.suggestedFilename(), 'board-games.ics');
  const ics = readFileSync(await download.path(), 'utf8');
  assert.match(ics, /SUMMARY:Board games\r\nLOCATION:My place/);
  assert.match(ics, new RegExp(`DTSTART:${tomorrow.replaceAll('-', '')}T180000`));

  // Everything is saved: reload and it's all there.
  const eventUrl = page.url();
  await page.reload();
  await page.waitForSelector('event-page h1');
  await settle(page);
  assert.equal(await page.textContent('event-page h1'), 'Board games');
  assert.equal(await page.textContent('event-page b.spent'), '$80.00');
  assert.equal(await page.textContent('event-page b.going'), '2');

  // Back to the calendar, where it's listed; then delete it, with a confirmation.
  await go('planner-app header a');
  assert.deepEqual(await texts('upcoming-list li strong'), ['Board games', 'Launch party', 'Quarterly planning']);
  await page.goto(eventUrl);
  await page.waitForSelector('event-page button.delete');
  await go('event-page button.delete');
  await go('event-page button.confirm-delete');
  assert.match(page.url(), /#\/$/);
  assert.deepEqual(await texts('upcoming-list li strong'), ['Launch party', 'Quarterly planning']);
  await page.goto(eventUrl);
  await page.waitForSelector('event-page .missing');
  assert.equal(await page.textContent('event-page h1'), 'Not found');

  // Escape closes the dialog without saving.
  await go('planner-app header a');
  await go('planner-app button.new-event');
  assert.equal(await dialog.evaluate((el) => el.open), true);
  await page.keyboard.press('Escape');
  await settle(page);
  assert.equal(await dialog.evaluate((el) => el.open), false);

  // The sample event's guests show their saved RSVPs.
  await page.goto(`${url}/#/events/e-launch`);
  await page.waitForSelector('event-page h1');
  await go('event-page [data-tab=guests]');
  assert.deepEqual(await page.$$eval('guest-list select', (els) => els.map((el) => el.value)), ['yes', 'maybe', 'pending']);

  assert.deepEqual(messages, []);
  await page.close();
});
