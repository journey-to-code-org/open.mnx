// shadcn/ui (Radix underneath, Tailwind 4) with Zubra components in one React app: Zubra's
// light-DOM components styled with Tailwind classes on shadcn's tokens; a shadow-DOM chart on
// shadcn's CSS variables; a Zubra form control submitted from inside a Radix Dialog (a portal);
// shadcn's theme menu (a Radix DropdownMenu) restyling both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('shadcn-invoices: shadcn/ui and Zubra components share one theme', async () => {
  const { page, messages } = await launch('shadcn-invoices', { colorScheme: 'light' });
  await page.waitForSelector('invoice-table tbody tr');
  await settle(page);
  const style = (selector, property) => page.locator(selector).first().evaluate(async (el, property) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished));
    return getComputedStyle(el)[property];
  }, property);
  const primary = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());

  // Zubra's light-DOM badge on shadcn's tokens: paid is bg-primary, like shadcn's Button.
  const button = 'header button:has-text("New invoice")';
  const badge = 'invoice-table tr[data-id=INV-1040] status-badge span';
  assert.equal(await style(badge, 'backgroundColor'), await style(button, 'backgroundColor'), 'the badge and shadcn\'s Button share --primary');
  assert.equal(await style(badge, 'borderTopLeftRadius'), '8px', 'rounded-md: shadcn\'s --radius (0.625rem) less 2px');
  // The shadow-DOM chart reads shadcn's variables through the shadow boundary.
  const bar = await page.evaluate(() => getComputedStyle(document.querySelector('revenue-chart').shadowRoot.querySelector('.paid')).backgroundColor);
  assert.equal(bar, await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--chart-1)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }), 'the paid bars are --chart-1');

  // Filtering (shadcn Buttons) changes the Zubra table's prop.
  await page.click('[aria-label=Show] button:has-text("paid")');
  await settle(page);
  assert.deepEqual(await texts(page, 'invoice-table tbody td:first-child'), ['INV-1040', 'INV-1039', 'INV-1037']);
  await page.click('[aria-label=Show] button:has-text("overdue")');
  await settle(page);
  assert.deepEqual(await texts(page, 'invoice-table tbody td:first-child'), ['INV-1041']);

  // A row opens a shadcn Dialog (Radix): "Mark as paid" updates the table and the stats.
  await page.click('invoice-table tr[data-id=INV-1041]');
  await page.waitForSelector('[role=dialog]');
  assert.equal(await page.textContent('[role=dialog] h2'), 'INV-1041');
  assert.equal(await page.textContent('[role=dialog] status-badge span'), 'overdue');
  await page.click('[role=dialog] button:has-text("Mark as paid")');
  await settle(page);
  assert.equal(await page.textContent('[role=dialog] status-badge span'), 'paid');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });
  assert.equal(await page.textContent('[data-stat=overdue]'), '0');
  assert.equal(await page.textContent('invoice-table caption'), 'No overdue invoices.');
  await page.click('[aria-label=Show] button:has-text("all")');
  await settle(page);

  // Enter on a focused row opens it too (the Zubra table's keyboard handling).
  await page.focus('invoice-table tr[data-id=INV-1042]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=dialog]');
  assert.equal(await page.textContent('[role=dialog] h2'), 'INV-1042');
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });

  // A new invoice: the Zubra status picker, inside the Radix Dialog's portal, submits with the form.
  await page.click(button);
  await page.waitForSelector('[role=dialog] form');
  await page.fill('#client', 'Acme Corp');
  await page.fill('#amount', '1500');
  await page.click('[role=dialog] status-picker [data-value=sent]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getAttribute('[role=dialog] status-picker [data-value=paid]', 'aria-checked'), 'true', 'arrow keys move the choice');
  await page.keyboard.press('ArrowLeft');
  await page.click('[role=dialog] button:has-text("Create invoice")');
  await page.waitForSelector('[role=dialog]', { state: 'detached' });
  await settle(page);
  assert.deepEqual((await texts(page, 'invoice-table tr[data-id=INV-1043] td')), ['INV-1043', 'Acme Corp', 'sent', 'Dec 15', '$1,500.00']);
  assert.equal(await page.textContent('[data-stat=outstanding]'), '$5,700.00');

  // shadcn's theme menu (a Radix DropdownMenu): the variables change, and Zubra follows.
  const before = { primary: await primary(), badge: await style(badge, 'backgroundColor') };
  await page.click('header button:has-text("Theme")');
  await page.click('[role=menuitemradio]:has-text("Blue")');
  await settle(page);
  assert.notEqual(await primary(), before.primary);
  assert.notEqual(await style(badge, 'backgroundColor'), before.badge, 'the badge follows the accent');
  assert.equal(await style(badge, 'backgroundColor'), await style(button, 'backgroundColor'));
  await page.click('header button:has-text("Theme")');
  await page.click('[role=menuitemradio]:has-text("Dark")');
  await settle(page);
  assert.deepEqual(await page.evaluate(() => [...document.documentElement.classList].sort()), ['dark', 'theme-blue']);
  const dark = await page.evaluate(() => getComputedStyle(document.querySelector('revenue-chart').shadowRoot.querySelector('.labels span')).color);
  assert.equal(dark, await style('[data-slot=card-description]', 'color'), 'the chart\'s labels are --muted-foreground in dark mode too');

  assert.deepEqual(messages, []);
  await page.close();
});
