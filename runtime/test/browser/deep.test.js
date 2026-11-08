// Deep reactivity in a compiled component: mutating a `let` array or object in a handler
// updates the DOM, with keyed rows kept. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({
  todo: join(here, 'fixtures/todo-mutable.mnx'),
});

const read = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('todo-list');
    return {
      items: [...el.querySelectorAll('li')].map((li) => `${li.textContent}${li.classList.contains('done') ? '*' : ''}`),
      left: el.querySelector('p').textContent,
    };
  });

test('push, splice, a nested write and a reassignment all update the DOM', async () => {
  const { page, messages } = await open('<todo-list></todo-list>', { modules: ['todo'] });
  assert.deepEqual(await read(page), { items: ['Write'], left: '1 left' });

  // push, from the form's submit handler
  await page.fill('todo-list input', 'Ship');
  await page.press('todo-list input', 'Enter');
  await page.evaluate(() => document.querySelector('todo-list').updateComplete);
  assert.deepEqual(await read(page), { items: ['Write', 'Ship'], left: '2 left' });
  assert.equal(await page.inputValue('todo-list input'), '', 'draft was reset');

  // a nested property write on one row updates that row only
  await page.evaluate(() => { window.secondLi = document.querySelectorAll('todo-list li')[1]; });
  await page.click('todo-list li:first-child');
  await page.evaluate(() => document.querySelector('todo-list').updateComplete);
  assert.deepEqual(await read(page), { items: ['Write*', 'Ship'], left: '1 left' });
  assert.equal(await page.evaluate(() => document.querySelectorAll('todo-list li')[1] === window.secondLi), true, 'the other row is the same element');

  // splice
  await page.click('todo-list button:has-text("Drop first")');
  await page.evaluate(() => document.querySelector('todo-list').updateComplete);
  assert.deepEqual(await read(page), { items: ['Ship'], left: '1 left' });
  assert.equal(await page.evaluate(() => document.querySelector('todo-list li') === window.secondLi), true, 'the kept row keeps its element');

  // a reassignment, then a mutation of the new array
  await page.click('todo-list li:first-child');
  await page.click('todo-list button:has-text("Clear done")');
  await page.evaluate(() => document.querySelector('todo-list').updateComplete);
  assert.deepEqual(await read(page), { items: [], left: '0 left' });
  await page.fill('todo-list input', 'Again');
  await page.press('todo-list input', 'Enter');
  await page.evaluate(() => document.querySelector('todo-list').updateComplete);
  assert.deepEqual(await read(page), { items: ['Again'], left: '1 left' });
  assert.deepEqual(messages, []);
});
