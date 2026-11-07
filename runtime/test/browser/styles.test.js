// Scoped <style>: light-DOM styles stop at slotted content (which belongs to whoever supplied
// it), sit in a cascade layer that utilities and page CSS override, and are shared by every
// instance; shadow components adopt theirs (and app-wide sheets from adoptStyles()), including
// after hydrating declarative shadow DOM. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site } from './harness.js';

useBrowser({
  'styled-card': join(here, 'fixtures/styled-card.mnx'),
  'styled-page': join(here, 'fixtures/styled-page.mnx'),
  'styled-panel': join(here, 'fixtures/styled-panel.mnx'),
});

const color = (page, selector) => page.$eval(selector, (el) => getComputedStyle(el).color);
const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve));
  await Promise.all([...document.querySelectorAll('*')].filter((el) => el.localName.startsWith('mnx-')).map((el) => el.updateComplete));
});

const RED = 'rgb(255, 0, 0)', GREEN = 'rgb(0, 128, 0)', BLUE = 'rgb(0, 0, 255)', BLACK = 'rgb(0, 0, 0)';

test("a component's styles apply to its own elements and stop at content slotted into it", async () => {
  const { page, messages } = await open(
    '<mnx-styled-card id="empty"></mnx-styled-card><mnx-styled-card id="filled"><h2 slot="title">Mine</h2><p>mine</p></mnx-styled-card>',
    { modules: ['styled-card'] },
  );
  assert.equal(await color(page, '#empty h2'), RED);
  assert.equal(await color(page, '#empty p'), GREEN, 'its fallback is its own');
  assert.equal(await page.$eval('#empty', (el) => getComputedStyle(el).display), 'block', ':host means the host');
  assert.equal(await color(page, '#filled h2'), BLACK, "the caller's heading isn't styled by the card");
  assert.equal(await color(page, '#filled p'), BLACK);
  assert.deepEqual(await page.$$eval('#filled [data-mnx-slotted]', (els) => els.map((el) => [el.localName, el.dataset.mnxSlotted])),
    [['h2', 'mnx-styled-card'], ['p', 'mnx-styled-card']]);
  assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 1, 'one sheet, shared by every instance');
  assert.deepEqual(messages, []);
  await page.close();
});

test('content added and removed later is marked and unmarked; utilities and page CSS override', async () => {
  const { page } = await open(
    `<style>
      @layer utilities { .u-green { color: rgb(0, 128, 0) } }
      .page-blue { color: rgb(0, 0, 255) }
    </style>
    <mnx-styled-card></mnx-styled-card>`,
    { modules: ['styled-card'] },
  );
  await page.evaluate(() => {
    const card = document.querySelector('mnx-styled-card');
    window.added = Object.assign(document.createElement('p'), { textContent: 'added' });
    card.appendChild(window.added);
    card.shadowFree = true;
  });
  await settle(page);
  assert.equal(await page.evaluate(() => window.added.dataset.mnxSlotted), 'mnx-styled-card');
  assert.equal(await page.evaluate(() => getComputedStyle(window.added).color), BLACK);
  await page.evaluate(() => document.querySelector('mnx-styled-card').removeChild(window.added));
  await settle(page);
  assert.equal(await page.evaluate(() => window.added.hasAttribute('data-mnx-slotted')), false, "our mark doesn't stay on the caller's element");

  // The component's own h2 is red; a utility class (the `utilities` layer) and unlayered page CSS win.
  await page.evaluate(() => document.querySelector('mnx-styled-card h2').classList.add('u-green'));
  assert.equal(await color(page, 'mnx-styled-card h2'), GREEN);
  await page.evaluate(() => document.querySelector('mnx-styled-card h2').classList.replace('u-green', 'page-blue'));
  assert.equal(await color(page, 'mnx-styled-card h2'), BLUE);
  await page.close();
});

test("a parent's content in a child's slot is the parent's to style, including content it adds later", async () => {
  const { page, messages } = await open('<mnx-styled-page></mnx-styled-page>', { modules: ['styled-page'] });
  assert.equal(await color(page, '.mine'), BLUE, "the page's style");
  assert.equal(await color(page, 'mnx-styled-card h2'), RED, "the card's own heading");
  await page.evaluate(() => { document.querySelector('mnx-styled-page').show = true; });
  await settle(page);
  assert.equal(await page.$eval('.later', (el) => el.dataset.mnxSlotted), 'mnx-styled-card');
  assert.notEqual(await color(page, '.later'), GREEN, "the card's `p` rule doesn't reach the page's content");
  assert.deepEqual(messages, []);
  await page.close();
});

test('server-rendered markup carries the marks, so styles are right before and after hydrating', async () => {
  const css = compiler(join(here, 'fixtures/styled-page.mnx'), '--emit', 'css');
  const html = compiler(join(here, 'fixtures/styled-page.mnx'));
  writeFileSync(join(site, 'page.css'), css);
  // First without JavaScript: the page's <link> carries the --emit css output.
  const { page: plain } = await open(`<link rel="stylesheet" href="/page.css">${html}`, {});
  await plain.waitForFunction(() => document.querySelector('link').sheet?.cssRules.length > 0);
  assert.equal(await color(plain, '.mine'), BLUE);
  assert.equal(await color(plain, 'mnx-styled-card h2'), RED);
  await plain.close();

  const { page, messages } = await open(html, { modules: ['styled-page'] });
  await page.evaluate(() => { window.mine = document.querySelector('.mine'); });
  await settle(page);
  assert.equal(await page.evaluate(() => window.mine === document.querySelector('.mine')), true, 'hydrated, not re-rendered');
  assert.equal(await color(page, '.mine'), BLUE);
  assert.deepEqual(messages, []);
  await page.close();
});

test('shadow components adopt their sheet, and app-wide sheets through adoptStyles()', async () => {
  const { page, messages } = await open('<mnx-styled-panel><b>slotted</b></mnx-styled-panel>', {
    beforeModules: "const { adoptStyles } = await import('@mnx/runtime'); window.adoptStyles = adoptStyles;",
    modules: ['styled-panel'],
  });
  const h3 = () => page.evaluate(() => getComputedStyle(document.querySelector('mnx-styled-panel').shadowRoot.querySelector('h3')).color);
  assert.equal(await h3(), RED);
  await page.evaluate(() => window.adoptStyles('h3 { color: rgb(0, 0, 255) !important }'));
  assert.equal(await h3(), BLUE, 'a sheet adopted later reaches existing shadow roots');
  await page.evaluate(() => document.body.append(document.createElement('mnx-styled-panel')));
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelectorAll('mnx-styled-panel')[1].shadowRoot.querySelector('h3')).color), BLUE, 'and new ones');
  assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 0, "a shadow component's styles stay in its shadow roots");
  assert.deepEqual(messages, []);
  await page.close();
});

test('a declarative shadow root from the server is hydrated, its <style> replaced by the shared sheet', async () => {
  const html = compiler(join(here, 'fixtures/styled-panel.mnx'));
  const { page: plain } = await open(html, {});
  assert.equal(await plain.evaluate(() => getComputedStyle(document.querySelector('mnx-styled-panel').shadowRoot.querySelector('h3')).color), RED,
    'styled before any JavaScript');
  await plain.close();
  const { page, messages } = await open(html, {
    beforeModules: "window.h3 = document.querySelector('mnx-styled-panel').shadowRoot.querySelector('h3');",
    modules: ['styled-panel'],
  });
  const state = await page.evaluate(() => {
    const root = document.querySelector('mnx-styled-panel').shadowRoot;
    return { same: root.querySelector('h3') === window.h3, styles: root.querySelectorAll('style').length, adopted: root.adoptedStyleSheets.length, color: getComputedStyle(window.h3).color };
  });
  assert.deepEqual(state, { same: true, styles: 0, adopted: 1, color: RED });
  assert.deepEqual(messages, []);
  await page.close();
});

test("content removed through its real parent loses the mark too", async () => {
  const { page } = await open('<mnx-styled-card><p id="mine">mine</p></mnx-styled-card>', { modules: ['styled-card'] });
  await page.evaluate(() => { window.mine = document.getElementById('mine'); window.mine.parentNode.removeChild(window.mine); });
  await settle(page);
  assert.equal(await page.evaluate(() => window.mine.hasAttribute('data-mnx-slotted')), false);
  await page.close();
});

test('a styled light-DOM component inside a shadow root brings its styles there', async () => {
  const { page, messages } = await open('<mnx-styled-panel></mnx-styled-panel>', { modules: ['styled-panel', 'styled-card'] });
  const inner = await page.evaluate(async () => {
    const root = document.querySelector('mnx-styled-panel').shadowRoot;
    const card = document.createElement('mnx-styled-card');
    root.append(card);
    await card.updateComplete;
    return getComputedStyle(card.querySelector('h2')).color;
  });
  assert.equal(inner, RED, 'document styles do not reach into a shadow root, so the sheet is adopted there');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a component whose CSS a bundler put in the page adopts it only into shadow roots', async () => {
  const { page, messages } = await open('<div id="host"></div>', {
    beforeModules: `
      import { $define } from '@mnx/runtime';
      // What @mnx/unplugin emits for a light-DOM component: the CSS is in the page, and the text
      // comes along for shadow roots (inPage).
      document.head.insertAdjacentHTML('beforeend', '<style>@scope (bundled-card) { p { color: rgb(255, 0, 0) } }</style>');
      $define('bundled-card', { abi: 2, props: {}, styled: true, inPage: true, styles: '@scope (bundled-card) { p { color: rgb(255, 0, 0) } }', template: '<p>hi</p>', setup: () => [] });
    `,
  });
  const result = await page.evaluate(async () => {
    const inDocument = document.createElement('bundled-card');
    document.body.append(inDocument);
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    const inShadow = document.createElement('bundled-card');
    root.append(inShadow);
    await Promise.all([inDocument.updateComplete, inShadow.updateComplete]);
    return {
      documentSheets: document.adoptedStyleSheets.length,
      shadowSheets: root.adoptedStyleSheets.length,
      colors: [getComputedStyle(inDocument.querySelector('p')).color, getComputedStyle(inShadow.querySelector('p')).color],
    };
  });
  assert.deepEqual(result, { documentSheets: 0, shadowSheets: 1, colors: [RED, RED] });
  assert.deepEqual(messages, []);
  await page.close();
});
