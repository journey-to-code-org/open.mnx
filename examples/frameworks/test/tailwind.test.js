// Tailwind CSS 4: utility classes in .zb templates, found by Tailwind's scanner; light-DOM
// components styled by the page's CSS; a shadow-DOM component styled by the same CSS through
// adoptStyles(); variants (aria-pressed:, data-active:, hover:, disabled:) and a theme colour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('tailwind-cafe: Tailwind utilities style light-DOM and shadow-DOM Zubra components', async () => {
  const { page, messages } = await launch('tailwind-cafe', { colorScheme: 'light' });
  await page.waitForSelector('menu-card article');
  await settle(page);
  // Computed styles once Tailwind's transitions (transition, hover:, active:) have finished.
  const style = (selector, property) => page.locator(selector).first().evaluate(async (el, property) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
    return getComputedStyle(el)[property];
  }, property);

  // Light DOM: the page's Tailwind classes apply inside the components, as written in the .zb files.
  assert.equal(await style('menu-card article', 'borderTopLeftRadius'), '16px', 'rounded-2xl');
  assert.equal(await style('menu-card article', 'backgroundColor'), 'rgb(255, 255, 255)', 'bg-white');
  assert.equal(await style('menu-card[data-id=flat-white] button:has-text("Add")', 'backgroundColor'), 'oklch(0.666 0.179 58.318)', 'bg-amber-600');
  // A data-active: variant and a colour from the page's @theme (--color-roast).
  const medium = 'menu-card[data-id=flat-white] [aria-label="Size of Flat white"] button:has-text("m")';
  assert.equal(await style(medium, 'backgroundColor'), 'oklch(0.42 0.08 50)', 'data-active:bg-roast');
  assert.equal(await style('menu-card[data-id=flat-white] [aria-label="Size of Flat white"] button:has-text("s")', 'backgroundColor'), 'rgba(0, 0, 0, 0)');

  // An aria-pressed: variant on the category tabs, and filtering.
  assert.equal(await style('category-tabs button[aria-pressed=true]', 'backgroundColor'), 'rgb(255, 255, 255)', 'aria-pressed:bg-white');
  await page.click('category-tabs button:has-text("Bakery")');
  await settle(page);
  assert.deepEqual(await texts(page, 'menu-card h3'), ['Butter croissant', 'Cardamom bun']);
  assert.equal(await style('category-tabs button:has-text("Bakery")', 'backgroundColor'), 'rgb(255, 255, 255)');
  await page.click('category-tabs button:has-text("All")');
  await settle(page);

  // Shadow DOM: page CSS doesn't reach in; adoptStyles() puts Tailwind there.
  assert.equal(await style('order-summary section', 'borderTopLeftRadius'), '16px', 'rounded-2xl inside the shadow root');
  assert.equal(await style('order-summary button:has-text("Place order")', 'opacity'), '0.4', 'disabled:opacity-40, with nothing ordered');
  assert.equal(await page.evaluate(() => document.querySelector('order-summary').shadowRoot.adoptedStyleSheets.length > 0), true);

  // Ordering: a large flat white, a croissant, then one less flat white.
  await page.click(`${medium.replace('"m"', '"l"')}`);
  await page.click('menu-card[data-id=flat-white] button:has-text("Add")');
  await page.click('menu-card[data-id=flat-white] button:has-text("Add")');
  await page.click('menu-card[data-id=croissant] button:has-text("Add")');
  await settle(page);
  assert.deepEqual(await texts(page, 'menu-card[data-id=flat-white] button:has-text("Add")'), ['Add · $4.90 2'], 'the large price, and 2 in the order');
  assert.deepEqual(await texts(page, 'order-summary li .truncate'), ['Flat white', 'Butter croissant']);
  assert.equal(await page.textContent('order-summary [data-total]'), '$14.12', '$13.20 and 7% tax');
  await page.click('order-summary button[aria-label="Remove one Flat white"]');
  await settle(page);
  assert.equal(await page.textContent('order-summary [data-total]'), '$8.88');
  assert.equal(await style('order-summary button:has-text("Place order")', 'opacity'), '1');
  await page.click('order-summary button:has-text("Place order")');
  await settle(page);
  assert.match(await page.textContent('order-summary [role=status]'), /Order placed/);
  assert.equal(await style('order-summary [role=status]', 'backgroundColor'), 'oklch(0.979 0.021 166.113)', 'bg-emerald-50');

  // Dark mode (Tailwind's default: prefers-color-scheme) reaches the shadow root too.
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await style('order-summary section', 'backgroundColor'), 'oklch(0.216 0.006 56.043)', 'dark:bg-stone-900 in the shadow root');
  assert.equal(await style('menu-card article', 'backgroundColor'), 'oklch(0.216 0.006 56.043)', 'and in the light DOM');

  assert.deepEqual(messages, []);
  await page.close();
});
