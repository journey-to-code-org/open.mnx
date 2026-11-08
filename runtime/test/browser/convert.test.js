// `zubra convert`: a React component (tests/fixtures/convert/TodoItem.jsx), converted and run as a
// custom element. What React did with hooks, it does with state, effects and refs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useBrowser, open, repo } from './harness.js';

const dir = mkdtempSync(join(tmpdir(), 'zb-convert-'));
const converted = join(dir, 'todo-item.zb.jsx');
// (Registered before the harness's hooks, so the file exists when they compile it.)
before(() => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  execFileSync(join(repo, 'target/debug/zubra'), ['convert', join(repo, 'tests/fixtures/convert/TodoItem.jsx'), '--out', converted], { stdio: 'pipe' });
});
useBrowser({ 'todo-item': converted });

test('a converted React component works as an element: state, effects, refs and events', async () => {
  const { page, messages } = await open('<ul><todo-item text="Milk"></todo-item></ul>', {
    beforeModules: "window.events = []; for (const type of ['toggle', 'rename']) document.addEventListener(type, (event) => window.events.push([type, event.detail]));",
    modules: ['todo-item'],
  });
  const settle = () => page.evaluate(() => document.querySelector('todo-item').updateComplete);
  assert.equal(await page.textContent('todo-item span'), 'Milk');
  await page.click('todo-item input[type=checkbox]');
  // (Controlled from outside, as in React: the parent sets `done`.)
  await page.evaluate(() => { document.querySelector('todo-item').done = true; });
  await settle();
  assert.equal(await page.textContent('todo-item span'), 'Milk (done)', 'the useMemo is derived');

  await page.dblclick('todo-item span');
  await settle();
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('todo-item input:not([type])')), true, 'the useEffect focused the field through the ref');
  await page.fill('todo-item input:not([type])', 'Oat milk');
  await page.evaluate(() => document.activeElement.blur());
  await settle();
  assert.equal(await page.textContent('todo-item small'), '1 saves', 'a functional setState');
  assert.deepEqual(await page.evaluate(() => window.events), [['toggle', true], ['rename', 'Oat milk']]);
  assert.deepEqual(messages, ['log: mounted'], 'the useEffect(…, []) ran once, on mount');
  await page.close();
});
