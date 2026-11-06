// Keyed lists: rows follow their key, so reordering moves rows (and their DOM state) instead of
// rewriting their contents. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site } from './harness.js';

useBrowser({ todos: join(here, 'fixtures/todos.mnx') });

const T = (...ids) => ids.map((id) => ({ id, text: { 1: 'milk', 2: 'eggs', 3: 'bread', 4: 'jam' }[id] }));

/** Snapshot rows as "id@index:text" and tag each <li> so identity can be checked later. */
const rows = (page) =>
  page.$$eval('mnx-todos li', (items) => items.map((li) => `${li.dataset.id}@${li.dataset.i}:${li.textContent.trim()}`));

async function setTodos(page, todos) {
  await page.evaluate(async (todos) => {
    const el = document.querySelector('mnx-todos');
    el.todos = todos;
    await el.updateComplete;
  }, todos);
}

test('reordering moves rows with their DOM state, including focus', async () => {
  const { page, messages } = await open('<mnx-todos></mnx-todos>', { modules: ['todos'] });
  const eggs = page.locator('mnx-todos li[data-id="2"] input');
  await eggs.fill('eggs (dozen)');
  await eggs.focus();
  await page.evaluate(() => { window.liById = Object.fromEntries([...document.querySelectorAll('mnx-todos li')].map((li) => [li.dataset.id, li])); });

  await setTodos(page, T(3, 2, 1));
  assert.deepEqual(await rows(page), ['3@0:bread', '2@1:eggs', '1@2:milk']);
  const result = await page.evaluate(() => {
    const items = [...document.querySelectorAll('mnx-todos li')];
    const input = document.querySelector('mnx-todos li[data-id="2"] input');
    return {
      sameElements: items.every((li) => li === window.liById[li.dataset.id]),
      typed: input.value,
      focused: document.activeElement === input,
      hasMoveBefore: typeof Element.prototype.moveBefore === 'function',
    };
  });
  assert.equal(result.sameElements, true, 'each <li> is the same element, now in a new place');
  assert.equal(result.typed, 'eggs (dozen)', 'what the user typed moved with its row');
  if (result.hasMoveBefore) assert.equal(result.focused, true, 'moveBefore keeps focus');
  assert.deepEqual(messages, []);
  await page.close();
});

test('inserting and removing in the middle touches only those rows', async () => {
  const { page } = await open('<mnx-todos></mnx-todos>', { modules: ['todos'] });
  await page.evaluate(() => { window.liById = Object.fromEntries([...document.querySelectorAll('mnx-todos li')].map((li) => [li.dataset.id, li])); });
  await setTodos(page, T(1, 4, 2, 3));
  assert.deepEqual(await rows(page), ['1@0:milk', '4@1:jam', '2@2:eggs', '3@3:bread'], 'indexes update for moved rows');
  await setTodos(page, T(1, 3));
  assert.deepEqual(await rows(page), ['1@0:milk', '3@1:bread']);
  const kept = await page.evaluate(() =>
    [...document.querySelectorAll('mnx-todos li')].every((li) => li === window.liById[li.dataset.id]));
  assert.equal(kept, true);
  await setTodos(page, []);
  assert.deepEqual(await rows(page), []);
  await setTodos(page, T(2, 1));
  assert.deepEqual(await rows(page), ['2@0:eggs', '1@1:milk']);
  await page.close();
});

test('an item changing under the same key updates its row in place', async () => {
  const { page } = await open('<mnx-todos></mnx-todos>', { modules: ['todos'] });
  await page.evaluate(() => { window.first = document.querySelector('mnx-todos li'); });
  await setTodos(page, [{ id: 1, text: 'oat milk' }, ...T(2, 3)]);
  assert.deepEqual(await rows(page), ['1@0:oat milk', '2@1:eggs', '3@2:bread']);
  assert.equal(await page.evaluate(() => document.querySelector('mnx-todos li') === window.first), true);
  await page.close();
});

test('duplicate keys at runtime are reported and still render', async () => {
  const { page, messages } = await open('<mnx-todos></mnx-todos>', { modules: ['todos'] });
  await setTodos(page, [{ id: 1, text: 'a' }, { id: 1, text: 'b' }]);
  assert.deepEqual(await rows(page), ['1@0:a', '1@1:b']);
  assert.ok(messages.some((message) => message.startsWith('error:') && message.includes('duplicate mnx-each key')));
  await page.close();
});

test('a hydrated keyed list stays keyed', async () => {
  const props = join(site, 'todos.props.json');
  writeFileSync(props, JSON.stringify({ todos: T(1, 2) }));
  const html = compiler(join(here, 'fixtures/todos.mnx'), '--props', props);
  const { page, messages } = await open(html, {
    beforeModules: `window.liById = Object.fromEntries([...document.querySelectorAll('mnx-todos li')].map((li) => [li.dataset.id, li]));`,
    modules: ['todos'],
  });
  await setTodos(page, T(2, 1));
  assert.deepEqual(await rows(page), ['2@0:eggs', '1@1:milk']);
  const same = await page.evaluate(() =>
    [...document.querySelectorAll('mnx-todos li')].every((li) => li === window.liById[li.dataset.id]));
  assert.equal(same, true, 'server rows are moved, not re-created');
  assert.deepEqual(messages, []);
  await page.close();
});
