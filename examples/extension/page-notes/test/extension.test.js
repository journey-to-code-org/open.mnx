// The extension loaded into Chromium (Playwright's, which can load unpacked extensions) next to a
// test site whose CSS tries hard to restyle everything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dist = join(dirname(fileURLToPath(import.meta.url)), '../dist');
const SITE = `<!doctype html><html><head><title>A site</title><style>
  * { font-family: Georgia, serif !important; color: #c00 !important; }
  button { all: unset; background: hotpink !important; }
  section, p { display: none; }
</style></head><body><h1>A site with opinions</h1></body></html>`;

let context, server, site, id, worker;
before(async () => {
  server = createServer((request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(SITE));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  id = new URL(worker.url()).host;
});
after(async () => {
  await context?.close();
  server?.close();
});

async function open(url) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => ['error', 'warning'].includes(message.type()) && errors.push(message.text()));
  await page.goto(url);
  page.errors = errors;
  return page;
}
const popup = async () => {
  const page = await open(`chrome-extension://${id}/popup.html?url=${encodeURIComponent(site + '/')}`);
  await page.waitForSelector('body[data-ready]');
  return page;
};
const reset = () => worker.evaluate(() => chrome.storage.local.clear());

test('the popup: add notes (Ctrl+Enter or the button, with a colour), newest first, delete one; they persist', async () => {
  await reset();
  let page = await popup();
  assert.equal((await page.textContent('#site')).trim(), new URL(site).host);
  assert.equal((await page.textContent('note-list')).trim(), 'No notes for this site yet.');
  const add = page.getByRole('button', { name: 'Add note' });
  assert.equal(await add.isDisabled(), true);
  await page.fill('note-composer textarea', 'Check the pricing page');
  await page.keyboard.press('Control+Enter');
  await page.fill('note-composer textarea', 'Ask about the API');
  await page.click('color-swatches [data-color="#db2777"]');
  await add.click();
  assert.deepEqual(await page.locator('note-list p').allTextContents(), ['Ask about the API', 'Check the pricing page']);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('note-list li .stripe')).backgroundColor), 'rgb(219, 39, 119)');
  assert.equal(await page.inputValue('note-composer textarea'), '', 'the box empties after adding');
  await page.getByRole('button', { name: 'Delete note: Check the pricing page' }).click();
  assert.deepEqual(await page.locator('note-list p').allTextContents(), ['Ask about the API']);
  assert.deepEqual(page.errors, [], 'no CSP or other errors on an extension page');
  await page.close();
  page = await popup();
  assert.deepEqual(await page.locator('note-list p').allTextContents(), ['Ask about the API']);
  await page.close();
});

test('the toolbar badge counts the active site\'s notes', async () => {
  await reset();
  const tab = await open(site + '/badge');
  await worker.evaluate(async (origin) => chrome.storage.local.set({ [`notes:${origin}`]: [{ id: 'a', text: 'x', color: '#16a34a', at: 1 }, { id: 'b', text: 'y', color: '#16a34a', at: 2 }] }), site);
  const badge = () => worker.evaluate(async (url) => {
    const [found] = await chrome.tabs.query({ url: `${url}/*` });
    return chrome.action.getBadgeText({ tabId: found.id });
  }, site);
  await tab.waitForFunction(() => true);
  for (let tries = 0; tries < 20 && (await badge()) !== '2'; tries++) await tab.waitForTimeout(100);
  assert.equal(await badge(), '2');
  await tab.close();
});

test('the widget on the site: in a corner, out of reach of the site\'s CSS, live as notes change', async () => {
  await reset();
  await worker.evaluate(async (origin) => chrome.storage.local.set({ [`notes:${origin}`]: [{ id: 'n', text: 'Newest note', color: '#2563eb', at: 2 }, { id: 'o', text: 'Older', color: '#16a34a', at: 1 }] }), site);
  const page = await open(site + '/');
  const chip = page.locator('page-notes-widget').getByRole('button', { name: '2 notes' });
  await chip.waitFor();
  // The site's `* { … !important }` and `button { all: unset }` don't reach into the shadow root,
  // and `all: initial` on the host stops inherited fonts and colours.
  const style = await chip.evaluate((button) => {
    const computed = getComputedStyle(button);
    return [computed.backgroundColor, computed.color, computed.fontFamily];
  });
  assert.deepEqual(style.slice(0, 2), ['rgb(29, 33, 48)', 'rgb(255, 255, 255)']);
  assert.doesNotMatch(style[2], /Georgia/);
  await chip.click();
  assert.equal(await page.locator('page-notes-widget').getByRole('region', { name: 'Newest note' }).locator('p').textContent(), 'Newest note');
  // A note added in the popup shows up on the open page.
  await worker.evaluate(async (origin) => {
    const key = `notes:${origin}`;
    const notes = (await chrome.storage.local.get(key))[key];
    await chrome.storage.local.set({ [key]: [{ id: 'z', text: 'Added just now', color: '#ea580c', at: 3 }, ...notes] });
  }, site);
  await page.locator('page-notes-widget').getByRole('button', { name: '3 notes' }).waitFor();
  assert.equal(await page.locator('page-notes-widget .card p').textContent(), 'Added just now');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('the page can talk to the widget, but only as text: it can\'t inject markup', async () => {
  await reset();
  const page = await open(site + '/');
  // The bridge sends this site's (empty) notes once or twice as the page loads, and the last
  // send wins: send the page's own until the bridge has finished.
  const chip = page.locator('page-notes-widget').getByRole('button', { name: '1 note' });
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('page-notes:data', {
      detail: JSON.stringify([{ id: 'x', text: '<img src=x onerror="window.pwned = true">', color: 'red', at: 1 }]),
    })));
    await page.waitForTimeout(250);
    if (await chip.isVisible()) break;
  }
  await chip.click();
  assert.equal(await page.locator('page-notes-widget .card p').textContent(), '<img src=x onerror="window.pwned = true">');
  assert.equal(await page.locator('page-notes-widget img').count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await page.close();
});

test('hiding the widget on a site, and the options page: switch it off, default colour, show again', async () => {
  await reset();
  await worker.evaluate(async (origin) => chrome.storage.local.set({ [`notes:${origin}`]: [{ id: 'n', text: 'Hello', color: '#2563eb', at: 1 }] }), site);
  const page = await open(site + '/');
  await page.locator('page-notes-widget').getByRole('button', { name: '1 note' }).click();
  await page.locator('page-notes-widget').getByRole('button', { name: 'Hide on this site' }).click();
  await page.waitForFunction(() => !document.querySelector('page-notes-widget').shadowRoot.querySelector('button'));

  const options = await open(`chrome-extension://${id}/options.html`);
  await options.waitForSelector('body[data-ready]');
  assert.equal((await options.textContent('#hidden')).trim(), `${new URL(site).host} Show again`);
  await options.getByRole('button', { name: 'Show again' }).click();
  await page.locator('page-notes-widget').getByRole('button', { name: '1 note' }).waitFor();
  // Switching the widget off empties it everywhere; the default colour carries to the popup.
  await options.getByRole('switch', { name: 'Show notes on pages' }).click();
  await page.waitForFunction(() => !document.querySelector('page-notes-widget').shadowRoot.querySelector('button'));
  await options.click('color-swatches [data-color="#7c3aed"]');
  await options.waitForTimeout(100);
  const pop = await popup();
  assert.equal(await pop.evaluate(() => document.querySelector('note-composer').color), '#7c3aed');
  assert.deepEqual([...options.errors, ...pop.errors, ...page.errors], []);
  await Promise.all([pop.close(), options.close(), page.close()]);
});
