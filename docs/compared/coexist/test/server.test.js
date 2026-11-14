// The server-rendered order desk, per tool: what must work once the elements have started in
// the browser, and what each tool's page does before that (JavaScript off).
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { IMPLS } from '../hosts/config.mjs';
import { start } from '../hosts/server/server.mjs';
import { cleanup, open } from './harness.js';
import { probes } from './probes.js';

const impls = process.env.IMPLS?.split(',') ?? IMPLS;

// With JavaScript off. Lit and Stencil render into shadow roots, which a form doesn't look
// inside: their controls submit through ElementInternals, which needs the element running.
const BEFORE_JAVASCRIPT = {
  zubra: { rows: true, label: true, post: true },
  lit: { rows: true, label: true, post: false },
  stencil: { rows: true, label: true, post: false },
  enhance: { rows: true, label: true, post: true },
};

const rowIds = (page) => page.getByRole('row').evaluateAll((rows) => rows.slice(1).map((row) => row.querySelector('td')?.textContent.trim()));
const eventually = async (read, expected) => {
  let actual;
  for (let i = 0; i < 40; i++) {
    actual = await read();
    try {
      return assert.deepEqual(actual, expected);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.deepEqual(actual, expected);
};

after(cleanup);

for (const impl of impls) {
  describe(`${impl} on the server`, () => {
    test('the elements start on the server\'s markup and work', async () => {
      const server = await start(impl);
      const { page, problems, close } = await open(server.url);
      after(() => (close(), server.close()));
      await eventually(() => rowIds(page), ['1001', '1002', '1003']);
      await page.getByRole('columnheader', { name: 'Total' }).getByRole('button').click();
      await eventually(() => rowIds(page), ['1002', '1003', '1001']);
      await page.getByRole('button', { name: 'Increase Quantity' }).click();
      await eventually(() => page.getByLabel('Quantity', { exact: true }).inputValue(), '2');
      await eventually(() => page.getByRole('button', { name: 'Decrease Quantity' }).isDisabled(), false);
      // An empty customer comes back with the error in the control.
      await Promise.all([page.waitForLoadState('load'), page.getByRole('button', { name: 'Add order' }).click()]);
      await eventually(() => page.getByRole('alert').allTextContents(), ['Customer is required']);
      await page.getByLabel('Customer').fill('Ada');
      await page.getByRole('button', { name: 'Increase Quantity' }).click();
      await page.getByRole('button', { name: 'Increase Quantity' }).click();
      await eventually(() => page.getByLabel('Quantity', { exact: true }).inputValue(), '3');
      await Promise.all([page.waitForURL(/added=1004/), page.getByRole('button', { name: 'Add order' }).click()]);
      await eventually(() => page.getByRole('status').textContent(), 'Added order 1004 for Ada');
      await eventually(() => rowIds(page), ['1001', '1002', '1003', '1004']);
      await eventually(() => page.getByTestId('summary').textContent(), '4 orders, 1 shipped');
      // (Chromium logs the 422 the empty form came back with.)
      assert.deepEqual(problems.filter((problem) => !problem.includes('422')), []);
    });

    test('before JavaScript: what is in the page', async () => {
      const server = await start(impl);
      after(() => server.close());
      assert.deepEqual(await probes(open, server.url), BEFORE_JAVASCRIPT[impl]);
    });
  });
}
