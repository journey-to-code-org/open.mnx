// React 19: mnx elements imported as React components. Props (objects included), on<Event>
// handlers, React-managed children in an element's slots (reordered, filtered, added and
// removed by React), drag and drop, and an mnx form control used as a controlled input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts, engineNoise } from './harness.js';

test('react-board: a sprint board built from mnx elements', async () => {
  const { page, messages } = await launch('react-board');
  await page.waitForSelector('task-card article');
  await settle(page);
  const column = (id) => `kanban-column[data-column=${id}]`;
  const titles = (id) => texts(page, `${column(id)} task-card h3`);
  const go = async (selector) => { await page.click(selector); await settle(page); };

  assert.deepEqual(await titles('doing'), ['Sign-in with passkeys', 'Rate-limit the public API']);
  assert.equal(await page.textContent(`${column('doing')} .count`), '2');
  assert.match(await page.textContent('.progress'), /3 of 39 points done/);

  // Drag a card from To do to In progress, above the first card there.
  await page.dragAndDrop(`task-card[data-id=c3] article`, `task-card[data-id=c1] article`, { targetPosition: { x: 20, y: 5 } });
  await settle(page);
  assert.deepEqual(await titles('todo'), ['Audit log for admins']);
  assert.deepEqual(await titles('doing'), ['Export reports as CSV', 'Sign-in with passkeys', 'Rate-limit the public API']);
  // Over the column's limit: one more.
  await page.dragAndDrop(`task-card[data-id=c7] article`, `task-card[data-id=c4] article`, { targetPosition: { x: 20, y: 90 } });
  await settle(page);
  assert.deepEqual(await titles('doing'), ['Export reports as CSV', 'Sign-in with passkeys', 'Rate-limit the public API', 'Audit log for admins']);
  assert.equal(await page.textContent(`${column('doing')} .limit`), 'over the limit of 3');
  assert.equal(await page.$eval(`${column('doing')} section`, (el) => el.classList.contains('full')), true);
  assert.equal(await page.textContent(`${column('todo')} .empty`), 'Drop cards here', 'an emptied slot shows its fallback');

  // Undo goes back one move at a time.
  await go('button.undo');
  assert.deepEqual(await titles('doing'), ['Export reports as CSV', 'Sign-in with passkeys', 'Rate-limit the public API']);
  assert.deepEqual(await titles('todo'), ['Audit log for admins']);

  // The keyboard: Shift+→ to the next column, Shift+↑ up within it.
  await page.focus('task-card[data-id=c2] article');
  await page.keyboard.press('Shift+ArrowRight');
  await settle(page);
  assert.deepEqual(await titles('done'), ['Upgrade the build to Vite 8', 'Dark mode for settings']);
  await page.focus('task-card[data-id=c2] article');
  await page.keyboard.press('Shift+ArrowUp');
  await settle(page);
  assert.deepEqual(await titles('done'), ['Dark mode for settings', 'Upgrade the build to Vite 8']);
  assert.match(await page.textContent('.progress'), /6 of 39 points done/);

  // Filters are React state: the columns' children change, the counts don't.
  await page.selectOption('select[aria-label=Assignee]', 'Ada Lovelace');
  await settle(page);
  assert.deepEqual(await texts(page, 'task-card h3'), ['Audit log for admins', 'Sign-in with passkeys']);
  assert.equal(await page.textContent(`${column('doing')} .count`), '3');
  await page.selectOption('select[aria-label=Assignee]', '');
  await page.fill('input[aria-label="Filter cards"]', 'security');
  await settle(page);
  assert.deepEqual(await texts(page, 'task-card h3'), ['Audit log for admins', 'Sign-in with passkeys', 'Rate-limit the public API']);
  await page.fill('input[aria-label="Filter cards"]', '');
  await settle(page);

  // Edit a card: the tag input is an mnx element controlled by React state.
  await go('task-card[data-id=c5] article');
  const editor = page.locator('dialog.editor');
  assert.equal(await editor.locator('h2').textContent(), 'Edit card');
  await editor.locator('input[name=title]').fill('Empty states everywhere');
  await editor.locator('select[name=assignee]').selectOption('Grace Hopper');
  const tags = editor.locator('tag-input input');
  await tags.fill('Design System');
  await tags.press('Enter');
  await tags.fill('a11y');
  await tags.press(',');
  await settle(page);
  assert.deepEqual(await texts(page, 'tag-input .tag'), ['ui×', 'design-system×', 'a11y×']);
  await editor.locator('tag-input button[aria-label="Remove ui"]').click();
  await tags.press('Backspace');
  await settle(page);
  assert.deepEqual(await texts(page, 'tag-input .tag'), ['design-system×']);
  await editor.locator('button[type=submit]').click();
  await settle(page);
  assert.equal(await editor.count(), 0);
  assert.equal(await page.textContent('task-card[data-id=c5] h3'), 'Empty states everywhere');
  assert.deepEqual(await texts(page, 'task-card[data-id=c5] li'), ['design-system']);
  assert.equal(await page.textContent('task-card[data-id=c5] .avatar'), 'GH');

  // A new card from a column's slotted button; then delete one.
  await go(`${column('review')} button.add`);
  await editor.locator('input[name=title]').fill('Write the release notes');
  await editor.locator('select[name=points]').selectOption('2');
  await tags.fill('docs');
  await tags.press('Enter');
  await editor.locator('button[type=submit]').click();
  await settle(page);
  assert.deepEqual(await titles('review'), ['Write the release notes']);
  await go('task-card[data-id=c4] article');
  await editor.locator('button.danger').click();
  await settle(page);
  assert.deepEqual(await titles('doing'), ['Export reports as CSV', 'Sign-in with passkeys']);
  assert.equal(await page.$(`${column('doing')} section.full`), null);

  // Saved: a reload shows the same board.
  await page.reload();
  await page.waitForSelector('task-card article');
  await settle(page);
  assert.deepEqual(await titles('review'), ['Write the release notes']);
  assert.deepEqual(await titles('done'), ['Dark mode for settings', 'Upgrade the build to Vite 8']);
  await go('button.reset');
  assert.deepEqual(await titles('doing'), ['Sign-in with passkeys', 'Rate-limit the public API']);
  assert.deepEqual(messages.filter((message) => !engineNoise(message)), []);
  await page.close();
});
