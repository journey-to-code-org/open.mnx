// The contract every implementation must meet in every host: the same order desk, used the same
// way. Every check waits for its value (`eventually`), since some tools render after the event. Role and label locators only, so it doesn't matter whether a tool renders to light or
// shadow DOM. `IMPLS=zubra,lit HOSTS=react node --test test/hosts.test.js` narrows it.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTS, IMPLS } from '../hosts/config.mjs';
import { build, cleanup, open, serve } from './harness.js';

const impls = process.env.IMPLS?.split(',') ?? IMPLS;
const hosts = process.env.HOSTS?.split(',') ?? HOSTS;

const rowIds = (page) => page.getByRole('row').evaluateAll((rows) => rows.slice(1).map((row) => row.querySelector('td')?.textContent.trim()));
// A row's cells as text, read through any shadow roots inside them (a badge may have one).
const cells = (page, index) =>
  page.getByRole('row').nth(index).evaluate((row) => {
    const text = (node) => (node.nodeType === 3 ? node.data : node.nodeName === 'STYLE' ? '' : [...(node.shadowRoot ?? node).childNodes].map(text).join(''));
    return [...row.querySelectorAll('td')].map((cell) => text(cell).trim());
  });
const eventually = async (read, expected, message) => {
  let actual;
  for (let i = 0; i < 40; i++) {
    actual = await read();
    try {
      assert.deepEqual(actual, expected);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.deepEqual(actual, expected, message);
};

after(cleanup);

for (const impl of impls) {
  for (const host of hosts) {
    describe(`${impl} in ${host}`, () => {
      let url;
      const desk = async () => {
        url ??= await serve(await build(host, impl));
        const session = await open(url);
        await session.page.getByRole('table', { name: 'Orders' }).waitFor();
        return session;
      };

      test('shows the orders: object and array props reach the elements', async () => {
        const { page, problems, close } = await desk();
        assert.equal(await page.getByRole('heading', { name: 'Order desk' }).count(), 1);
        assert.deepEqual(await page.getByRole('tab').allTextContents(), ['Orders', 'New order']);
        await eventually(() => page.getByRole('tab', { name: 'Orders' }).getAttribute('aria-selected'), 'true');
        assert.deepEqual((await page.getByRole('columnheader').allTextContents()).map((text) => text.trim()), ['Order', 'Customer', 'Mugs', 'Total', 'Status', 'Actions']);
        await eventually(() => rowIds(page), ['1001', '1002', '1003']);
        await eventually(() => cells(page, 2), ['1002', 'Otis', '1', '$12.50', 'Pending', 'View']);
        await eventually(() => page.getByTestId('summary').textContent(), '3 orders, 1 shipped');
        assert.deepEqual(problems, []);
        await close();
      });

      test('sorts by a column, ascending then descending', async () => {
        const { page, problems, close } = await desk();
        const total = page.getByRole('columnheader', { name: 'Total' });
        await total.getByRole('button').click();
        await eventually(() => rowIds(page), ['1002', '1003', '1001']);
        await eventually(() => total.getAttribute('aria-sort'), 'ascending');
        await total.getByRole('button').click();
        await eventually(() => rowIds(page), ['1001', '1003', '1002']);
        await eventually(() => total.getAttribute('aria-sort'), 'descending');
        await page.getByRole('columnheader', { name: 'Customer' }).getByRole('button').click();
        await eventually(() => rowIds(page), ['1003', '1001', '1002']);
        await eventually(() => total.getAttribute('aria-sort'), null);
        assert.deepEqual(problems, []);
        await close();
      });

      test('tabs: a click and the arrow keys change the host\'s state', async () => {
        const { page, problems, close } = await desk();
        const orders = page.getByRole('tab', { name: 'Orders' });
        const fresh = page.getByRole('tab', { name: 'New order' });
        await orders.focus();
        await page.keyboard.press('ArrowRight');
        await eventually(() => fresh.getAttribute('aria-selected'), 'true');
        await eventually(() => orders.getAttribute('tabindex'), '-1');
        await eventually(() => fresh.evaluate((tab) => (tab.getRootNode().activeElement ?? document.activeElement) === tab), true, 'focus follows the selection');
        await eventually(() => page.getByRole('tabpanel', { name: 'New order' }).isVisible(), true);
        await eventually(() => page.getByRole('tabpanel', { name: 'Orders' }).isHidden(), true);
        await page.keyboard.press('ArrowRight'); // wraps
        await eventually(() => orders.getAttribute('aria-selected'), 'true');
        await page.keyboard.press('End');
        await eventually(() => fresh.getAttribute('aria-selected'), 'true');
        await orders.click();
        await eventually(() => page.getByRole('tabpanel', { name: 'Orders' }).isVisible(), true);
        assert.deepEqual(problems, []);
        await close();
      });

      test('the form controls are two-way: the host sees what is typed and pressed', async () => {
        const { page, problems, close } = await desk();
        await page.getByRole('tab', { name: 'New order' }).click();
        const quantity = page.getByLabel('Quantity', { exact: true });
        await eventually(() => quantity.inputValue(), '1');
        await eventually(() => page.getByRole('button', { name: 'Decrease Quantity' }).isDisabled(), true);
        await page.getByRole('button', { name: 'Increase Quantity' }).click();
        await page.getByRole('button', { name: 'Increase Quantity' }).click();
        await eventually(() => page.getByTestId('total').textContent(), 'Total: $37.50');
        await eventually(() => quantity.inputValue(), '3');
        await quantity.fill('25'); // past max: clamped
        await quantity.press('Tab');
        await eventually(() => page.getByTestId('total').textContent(), 'Total: $125.00');
        await eventually(() => quantity.inputValue(), '10');
        await eventually(() => page.getByRole('button', { name: 'Increase Quantity' }).isDisabled(), true);
        await page.getByRole('button', { name: 'Decrease Quantity' }).click();
        await eventually(() => page.getByTestId('total').textContent(), 'Total: $112.50');
        assert.deepEqual(problems, []);
        await close();
      });

      test('the form submits the controls: an error, then a new order', async () => {
        const { page, problems, close } = await desk();
        await page.getByRole('tab', { name: 'New order' }).click();
        const customer = page.getByLabel('Customer');
        assert.equal(await page.getByRole('alert').count(), 0);
        await page.getByRole('button', { name: 'Add order' }).click();
        await eventually(() => page.getByRole('alert').allTextContents(), ['Customer is required']);
        await eventually(() => customer.getAttribute('aria-invalid'), 'true');
        await customer.fill('Ada');
        await page.getByRole('button', { name: 'Increase Quantity' }).click();
        // Wait for the host to have rendered it: Angular renders after the event, not during it.
        await eventually(() => page.getByTestId('total').textContent(), 'Total: $25.00');
        await customer.press('Enter'); // submits from inside the control
        await eventually(() => page.getByRole('status').textContent(), 'Added order 1004 for Ada');
        await eventually(() => page.getByRole('tabpanel', { name: 'Orders' }).isVisible(), true);
        await eventually(() => rowIds(page), ['1001', '1002', '1003', '1004']);
        await eventually(() => cells(page, 4), ['1004', 'Ada', '2', '$25.00', 'Pending', 'View']);
        await eventually(() => page.getByTestId('summary').textContent(), '4 orders, 1 shipped');
        // The host reset its state, and the controls followed.
        await page.getByRole('tab', { name: 'New order' }).click();
        await eventually(() => customer.inputValue(), '');
        await eventually(() => page.getByLabel('Quantity', { exact: true }).inputValue(), '1');
        assert.equal(await page.getByRole('alert').count(), 0);
        await eventually(() => customer.getAttribute('aria-invalid'), 'false');
        assert.deepEqual(problems, []);
        await close();
      });

      test('the dialog shows the host\'s content, and closing it reaches the host', async () => {
        const { page, problems, close } = await desk();
        assert.equal(await page.getByRole('dialog').count(), 0);
        await page.getByRole('button', { name: 'View order 1002' }).click();
        const dialog = page.getByRole('dialog', { name: 'Order 1002' });
        await dialog.waitFor();
        await eventually(() => page.getByTestId('detail').textContent(), 'Otis: 1 × Trail mug, $12.50');
        await eventually(() => page.getByTestId('detail').isVisible(), true);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        // The host heard it close: opening the same order again works.
        await page.getByRole('button', { name: 'View order 1002' }).click();
        await dialog.waitFor();
        await page.getByRole('button', { name: 'Close' }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: 'View order 1002' }).click();
        await dialog.waitFor();
        await page.getByRole('button', { name: 'Mark shipped' }).click();
        await dialog.waitFor({ state: 'hidden' });
        await eventually(() => page.getByRole('status').textContent(), 'Order 1002 shipped');
        await eventually(() => page.getByTestId('summary').textContent(), '3 orders, 2 shipped');
        await eventually(async () => (await cells(page, 2))[4], 'Shipped');
        // Another order, and the slotted content follows the host.
        await page.getByRole('button', { name: 'View order 1001' }).click();
        await page.getByRole('dialog', { name: 'Order 1001' }).waitFor();
        await eventually(() => page.getByTestId('detail').textContent(), 'Mabel: 4 × Trail mug, $50.00');
        await eventually(() => page.getByRole('button', { name: 'Mark shipped' }).isDisabled(), true);
        assert.deepEqual(problems, []);
        await close();
      });
    });
  }
}
