// What the server page does with JavaScript off, per tool. These are recorded, not required:
// measure.mjs prints them, and server.test.js holds what each tool does today.
export async function probes(open, url) {
  const { page, close } = await open(url, { javaScriptEnabled: false });
  const result = {};
  page.setDefaultTimeout(3000);
  try {
  // The orders are readable: the table's rows are in the page.
  result.rows = await page.getByRole('row').count() === 4 && await page.getByRole('cell', { name: 'Otis' }).isVisible();
  // The label names its input.
  result.label = await page.getByLabel('Customer').count() === 1;
  // The form posts what was typed, and the next page shows the order.
  if (result.label) {
    await page.getByLabel('Customer').fill('Ada');
    await page.getByLabel('Quantity', { exact: true }).fill('3');
  }
  await Promise.all([page.waitForLoadState('load'), page.getByRole('button', { name: 'Add order' }).click()]);
  result.post = (await page.getByRole('status').textContent()) === 'Added order 1004 for Ada' && (await page.getByRole('cell', { name: 'Ada' }).count()) === 1;
  } finally {
    await close();
  }
  return result;
}
