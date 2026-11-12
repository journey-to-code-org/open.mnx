// Keyed lists: rows follow their key, so reordering moves rows (and their DOM state) instead of
// rewriting their contents. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site, runtimeOnly } from './harness.js';

useBrowser({ todos: join(here, 'fixtures/todos.zb'), table: join(here, 'fixtures/table-rows.zb') });

const T = (...ids) => ids.map((id) => ({ id, text: { 1: 'milk', 2: 'eggs', 3: 'bread', 4: 'jam' }[id] }));

/** Snapshot rows as "id@index:text" and tag each <li> so identity can be checked later. */
const rows = (page) =>
  page.$$eval('zb-todos li', (items) => items.map((li) => `${li.dataset.id}@${li.dataset.i}:${li.textContent.trim()}`));

async function setTodos(page, todos) {
  await page.evaluate(async (todos) => {
    const el = document.querySelector('zb-todos');
    el.todos = todos;
    await el.updateComplete;
  }, todos);
}

test('reordering moves rows with their DOM state, including focus', async () => {
  const { page, messages } = await open('<zb-todos></zb-todos>', { modules: ['todos'] });
  const eggs = page.locator('zb-todos li[data-id="2"] input');
  await eggs.fill('eggs (dozen)');
  await eggs.focus();
  await page.evaluate(() => { window.liById = Object.fromEntries([...document.querySelectorAll('zb-todos li')].map((li) => [li.dataset.id, li])); });

  await setTodos(page, T(3, 2, 1));
  assert.deepEqual(await rows(page), ['3@0:bread', '2@1:eggs', '1@2:milk']);
  const result = await page.evaluate(() => {
    const items = [...document.querySelectorAll('zb-todos li')];
    const input = document.querySelector('zb-todos li[data-id="2"] input');
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
  const { page } = await open('<zb-todos></zb-todos>', { modules: ['todos'] });
  await page.evaluate(() => { window.liById = Object.fromEntries([...document.querySelectorAll('zb-todos li')].map((li) => [li.dataset.id, li])); });
  await setTodos(page, T(1, 4, 2, 3));
  assert.deepEqual(await rows(page), ['1@0:milk', '4@1:jam', '2@2:eggs', '3@3:bread'], 'indexes update for moved rows');
  await setTodos(page, T(1, 3));
  assert.deepEqual(await rows(page), ['1@0:milk', '3@1:bread']);
  const kept = await page.evaluate(() =>
    [...document.querySelectorAll('zb-todos li')].every((li) => li === window.liById[li.dataset.id]));
  assert.equal(kept, true);
  await setTodos(page, []);
  assert.deepEqual(await rows(page), []);
  await setTodos(page, T(2, 1));
  assert.deepEqual(await rows(page), ['2@0:eggs', '1@1:milk']);
  await page.close();
});

test('a reorder moves only the rows that are out of order: a swap moves two', async () => {
  const { page, messages } = await open('<zb-todos></zb-todos>', { modules: ['todos'] });
  const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, text: `item ${i + 1}` }));
  await setTodos(page, many);
  // Count the rows put back into the list: a move is a removal and an insertion of its <li>.
  const moved = async (todos) => {
    await page.evaluate(() => {
      window.inserted = 0;
      window.observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node.nodeName === 'LI') window.inserted++;
      });
      window.observer.observe(document.querySelector('zb-todos ul'), { childList: true });
    });
    await setTodos(page, todos);
    return page.evaluate(() => { window.observer.disconnect(); return window.inserted; });
  };
  const swapped = [...many];
  [swapped[1], swapped[98]] = [swapped[98], swapped[1]];
  assert.equal(await moved(swapped), 2, 'rows 2 and 99 swap; the 96 between them stay');
  assert.deepEqual((await rows(page)).slice(0, 3), ['1@0:item 1', '99@1:item 99', '3@2:item 3']);
  // The last row to the front moves one row, not ninety-nine.
  assert.equal(await moved([swapped[99], ...swapped.slice(0, 99)]), 1);
  // Reversed, all but one row has to move.
  const reversed = [swapped[99], ...swapped.slice(0, 99)].reverse();
  assert.equal(await moved(reversed), 99);
  assert.deepEqual(await rows(page), reversed.map((todo, i) => `${todo.id}@${i}:${todo.text}`));
  assert.deepEqual(messages, []);
  await page.close();
});

test('random reorders with rows added and removed end in the list order, and rows that stay keep their elements', async () => {
  const { page, messages } = await open('<zb-todos></zb-todos>', { modules: ['todos'] });
  // A seeded shuffle, so a failure is the same failure on the next run.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let next = 1;
  let list = Array.from({ length: 30 }, () => ({ id: next++, text: `t${next}` }));
  await setTodos(page, list);
  for (let round = 0; round < 40; round++) {
    await page.evaluate(() => { window.liById = Object.fromEntries([...document.querySelectorAll('zb-todos li')].map((li) => [li.dataset.id, li])); });
    const kept = list.filter(() => random() > 0.15);
    for (let i = kept.length - 1; i > 0; i--) {
      if (random() < 0.3) {
        const j = Math.floor(random() * (i + 1));
        [kept[i], kept[j]] = [kept[j], kept[i]];
      }
    }
    const added = Array.from({ length: Math.floor(random() * 5) }, () => ({ id: next++, text: `t${next}` }));
    for (const todo of added) kept.splice(Math.floor(random() * (kept.length + 1)), 0, todo);
    list = kept;
    await setTodos(page, list);
    assert.deepEqual(await rows(page), list.map((todo, i) => `${todo.id}@${i}:${todo.text}`), `round ${round}`);
    const same = await page.evaluate(() => [...document.querySelectorAll('zb-todos li')].filter((li) => window.liById[li.dataset.id]).every((li) => li === window.liById[li.dataset.id]));
    assert.equal(same, true, `round ${round}: a row that stayed kept its element`);
  }
  assert.deepEqual(messages, []);
  await page.close();
});

test('clearing or replacing every row, alone in its <tbody> or beside other content', async () => {
  const { page, messages } = await open('<zb-table></zb-table>', { modules: ['table'] });
  const set = (ids) => page.evaluate(async (ids) => {
    const el = document.querySelector('zb-table');
    el.rows = ids.map((id) => ({ id }));
    await el.updateComplete;
  }, ids);
  const state = () => page.evaluate(() => ({
    cells: [...document.querySelectorAll('zb-table td')].map((td) => td.textContent),
    items: [...document.querySelectorAll('zb-table li')].map((li) => li.textContent),
    // Only the list's markers and blank text may be left in a <tbody> with no rows.
    tbody: [...document.querySelector('zb-table tbody').childNodes].filter((node) => node.nodeType === 1 || (node.nodeType === 3 && node.data.trim())).length,
  }));
  await set([1, 2, 3]);
  assert.deepEqual(await state(), { cells: ['1', '2', '3'], items: ['first', '1', '2', '3', 'last'], tbody: 3 });
  // Nothing reused: every row goes at once (a <tbody> holding only the list is emptied whole).
  await set([4, 5]);
  assert.deepEqual(await state(), { cells: ['4', '5'], items: ['first', '4', '5', 'last'], tbody: 2 });
  await set([]);
  assert.deepEqual(await state(), { cells: [], items: ['first', 'last'], tbody: 0 });
  // The markers survived, so the list fills again in the same place, twice over.
  await set([6]);
  assert.deepEqual(await state(), { cells: ['6'], items: ['first', '6', 'last'], tbody: 1 });
  await set([]);
  await set([7, 8]);
  assert.deepEqual(await state(), { cells: ['7', '8'], items: ['first', '7', '8', 'last'], tbody: 2 });
  assert.deepEqual(messages, []);
  await page.close();
});

test('an item changing under the same key updates its row in place', async () => {
  const { page } = await open('<zb-todos></zb-todos>', { modules: ['todos'] });
  await page.evaluate(() => { window.first = document.querySelector('zb-todos li'); });
  await setTodos(page, [{ id: 1, text: 'oat milk' }, ...T(2, 3)]);
  assert.deepEqual(await rows(page), ['1@0:oat milk', '2@1:eggs', '3@2:bread']);
  assert.equal(await page.evaluate(() => document.querySelector('zb-todos li') === window.first), true);
  await page.close();
});

test('duplicate keys at runtime are reported and still render', async () => {
  const { page, messages } = await open('<zb-todos></zb-todos>', { modules: ['todos'] });
  await setTodos(page, [{ id: 1, text: 'a' }, { id: 1, text: 'b' }]);
  assert.deepEqual(await rows(page), ['1@0:a', '1@1:b']);
  assert.ok(messages.some((message) => message.startsWith('error:') && message.includes('duplicate zb-each key')));
  await page.close();
});

test('a hydrated keyed list stays keyed', { skip: runtimeOnly }, async () => {
  const props = join(site, 'todos.props.json');
  writeFileSync(props, JSON.stringify({ todos: T(1, 2) }));
  const html = compiler(join(here, 'fixtures/todos.zb'), '--props', props);
  const { page, messages } = await open(html, {
    beforeModules: `window.liById = Object.fromEntries([...document.querySelectorAll('zb-todos li')].map((li) => [li.dataset.id, li]));`,
    modules: ['todos'],
  });
  await setTodos(page, T(2, 1));
  assert.deepEqual(await rows(page), ['2@0:eggs', '1@1:milk']);
  const same = await page.evaluate(() =>
    [...document.querySelectorAll('zb-todos li')].every((li) => li === window.liById[li.dataset.id]));
  assert.equal(same, true, 'server rows are moved, not re-created');
  assert.deepEqual(messages, []);
  await page.close();
});
