// id() on the server: the ids are in the server's HTML, so labels and aria references work
// before JavaScript, and the element keeps them when it hydrates. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, runtimeOnly } from './harness.js';

useBrowser({
  'id-field': join(here, 'fixtures/id-field.zb'),
  'id-form': join(here, 'fixtures/id-form.zb'),
});

const ids = (page) => page.$$eval('id-form id-field', (fields) => fields.map((field) => ({
  linked: field.querySelector('label').control === field.querySelector('input'),
  input: field.querySelector('input').id,
  described: field.querySelector('input').getAttribute('aria-describedby'),
  hint: field.querySelector('small').id,
})));

test('ids from id() are in the server HTML, and hydration keeps them', { skip: runtimeOnly }, async () => {
  const html = compiler(join(here, 'fixtures/id-form.zb'));
  const { page: plain } = await open(html, {});
  const before = await ids(plain);
  assert.deepEqual(before, [
    { linked: true, input: 'id-field-s1-1', described: 'id-field-s1-2', hint: 'id-field-s1-2' },
    { linked: true, input: 'last-1', described: 'last-2', hint: 'last-2' },
  ], 'labels and aria references work without JavaScript');
  await plain.close();

  // An element made in the browser before the others upgrade takes the first instance number,
  // so ids from the element's own count would differ from the server's.
  const { page, messages } = await open(html, {
    modules: ['id-form'],
    beforeModules: 'document.body.prepend(document.createElement("id-field"));',
  });
  await page.evaluate(() => Promise.all([...document.querySelectorAll('id-field')].map((el) => el.updateComplete)));
  assert.deepEqual(await ids(page), before, 'the element uses the ids it was rendered with');
  // What the element renders later uses the same ids.
  assert.equal(await page.evaluate(async () => {
    const field = document.querySelector('id-form id-field');
    field.more = true;
    await field.updateComplete;
    return field.querySelector('output').htmlFor.value;
  }), 'id-field-s1-1');
  // One made in the browser gets ids of its own.
  const made = await page.evaluate(async () => {
    const field = document.createElement('id-field');
    document.body.append(field);
    await field.updateComplete;
    return field.querySelector('input').id;
  });
  assert.ok(!before.some((field) => field.input === made), `${made} is new`);
  assert.deepEqual(messages, []);
  await page.close();
});
