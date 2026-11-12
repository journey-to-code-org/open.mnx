// Context on the server: a component's provide() reaches the components rendered inside it in
// the server's HTML, and hydration keeps the value without showing the default first.
// `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { useBrowser, open, compiler, here, runtimeOnly } from './harness.js';

const fixtures = join(here, 'fixtures/ctx');
useBrowser(
  { 'ctx-themed': join(fixtures, 'ctx-themed.zb'), 'ctx-shell': join(fixtures, 'ctx-shell.zb') },
  { 'theme.js': readFileSync(join(fixtures, 'theme.js'), 'utf8') },
);

test("a provided context is in the server's HTML, and hydration keeps it", { skip: runtimeOnly }, async () => {
  const html = compiler(join(fixtures, 'ctx-shell.zb'));
  assert.match(html, /<p class="dark">dark<\/p>/, 'rendered with the value the shell provides');
  assert.match(compiler(join(fixtures, 'ctx-themed.zb')), /<p class="light">light<\/p>/, "alone: the context's default");

  // Watch the paragraph from before the modules load: it never shows the default.
  const { page, messages } = await open(html, {
    modules: ['ctx-shell'],
    beforeModules: `window.seen = [];
      const p = document.querySelector('ctx-themed p');
      new MutationObserver(() => window.seen.push(p.className + ':' + p.textContent)).observe(p, { attributes: true, characterData: true, childList: true, subtree: true });`,
  });
  await page.evaluate(() => Promise.all([...document.querySelectorAll('ctx-shell, ctx-themed')].map((el) => el.updateComplete)));
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(await page.$eval('ctx-themed p', (p) => `${p.className}:${p.textContent}`), 'dark:dark');
  assert.deepEqual(await page.evaluate(() => window.seen.filter((state) => state !== 'dark:dark')), [], 'no flash of the default');
  // And it still follows the provider.
  await page.evaluate(() => { document.querySelector('ctx-shell').tone = 'sepia'; });
  await page.evaluate(() => Promise.all([...document.querySelectorAll('ctx-shell, ctx-themed')].map((el) => el.updateComplete)));
  assert.equal(await page.$eval('ctx-themed p', (p) => p.textContent), 'sepia');
  assert.deepEqual(messages, []);
  await page.close();
});
