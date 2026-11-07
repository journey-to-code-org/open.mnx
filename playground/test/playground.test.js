// The playground in Chromium: it compiles in the page (mnx.wasm when built, else the test
// server's native compiler), runs the component in each preview, shows every output, reports
// errors, and keeps the example in a link. `node --test playground/test/`.
// With MNX_REQUIRE_WASM=1, the site must have mnx.wasm and the page must use it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const { chromium } = createRequire(join(repo, 'runtime/package.json'))('playwright');
const wasm = process.env.MNX_REQUIRE_WASM === '1';
// React and Vue previews need examples/frameworks' toolchain (`npm ci` there).
const frameworks = existsSync(join(repo, 'examples/frameworks/node_modules/react'));
const out = join(here, '.tmp/site');

let server, browser;
before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  execFileSync(process.execPath, [join(here, '../build.mjs'), '--out', out, ...(wasm ? ['--require-wasm'] : []), ...(frameworks ? [] : ['--no-frameworks'])], { stdio: 'inherit' });
  server = await serve(out, { compiler: join(repo, 'target/debug/mnx') });
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

async function openPlayground(hash = '') {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.url + hash);
  await page.waitForFunction(() => window.playgroundReady === true);
  return { page, errors };
}

const frame = async (page, kind) => {
  const handle = await page.waitForSelector(`[data-preview=${kind}] iframe`);
  const content = await handle.contentFrame();
  await content.waitForFunction(() => window.previewReady === true);
  return content;
};

test('compiles in the page and runs the component in every preview', async () => {
  const { page, errors } = await openPlayground();
  assert.equal(await page.textContent('#status'), `Compiled (${wasm ? 'WebAssembly' : existsSync(join(out, 'mnx.wasm')) ? 'WebAssembly' : 'server'})`);
  const html = await frame(page, 'html');
  assert.deepEqual(await html.$$eval('hello-counter output', (els) => els.map((el) => el.textContent)), ['Apples: 0', 'Clicks: 5']);
  await html.click('hello-counter >> nth=0 >> button.more');
  await html.waitForFunction(() => document.querySelector('hello-counter output').textContent === 'Apples: 1');

  const kinds = await page.$$eval('[data-preview]', (els) => els.map((el) => el.dataset.preview));
  assert.deepEqual(kinds, frameworks ? ['html', 'react', 'vue'] : ['html']);
  for (const kind of kinds.slice(1)) {
    const preview = await frame(page, kind);
    await preview.waitForSelector('hello-counter output');
    assert.equal(await preview.textContent('hello-counter output'), 'Clicks: 0', kind);
    await preview.click('hello-counter button.more');
    await preview.waitForFunction(() => document.querySelector('hello-counter output').textContent === 'Clicks: 1');
  }

  // Every output, in its tab.
  await page.click('[role=tab][data-tab=js]');
  assert.match(await page.textContent('#out-js'), /\$define\(tag, \{/);
  assert.match(await page.textContent('#out-html'), /<hello-counter>\s*<button type="button" class="less" disabled>−<\/button>\s*<output>Clicks: 0<\/output>/);
  assert.match(await page.textContent('#out-dts'), /countchange: CustomEvent<number>/);
  assert.match(await page.textContent('#out-manifest'), /"tagName": "hello-counter"/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('an edit recompiles; an error shows with its location; the link keeps the example', async () => {
  const { page, errors } = await openPlayground();
  const source = await page.inputValue('#source');
  await page.fill('#source', source.replace('label="Clicks"', 'label="Taps"'));
  await page.fill('#page', '<hello-counter></hello-counter>');
  await page.waitForFunction(() => document.querySelector('#out-js').textContent.includes('"Taps"'));
  const html = await frame(page, 'html');
  assert.equal(await html.textContent('hello-counter output'), 'Taps: 0');

  await page.fill('#source', source.replace('onclick={() => count++}', 'onclick={() => count++'));
  await page.waitForSelector('#error:not([hidden])');
  assert.match(await page.textContent('#error'), /component\.mnx:\d+:\d+/);
  assert.equal(await page.textContent('#status'), 'Compile error');

  await page.fill('#source', source.replace('label="Clicks"', 'label="Taps"'));
  await page.waitForFunction(() => document.querySelector('#error').hidden);
  await page.waitForFunction(() => location.hash.length > 1);
  const link = new URL(page.url()).hash;
  const { page: shared } = await openPlayground(link);
  assert.match(await shared.inputValue('#source'), /label="Taps"/);
  assert.equal(await shared.inputValue('#page'), '<hello-counter></hello-counter>');
  assert.deepEqual(errors, []);
  await page.close();
  await shared.close();
});

test('the examples: slots with hasSlot, and a list with directives', async () => {
  const { page, errors } = await openPlayground();
  await page.selectOption('#example', 'slots');
  await page.waitForFunction(() => document.querySelector('#out-js').textContent.includes('info-card'));
  const cards = await frame(page, 'html');
  assert.deepEqual(await cards.$$eval('info-card', (els) => els.map((el) => !!el.querySelector('footer'))), [true, false]);

  await page.selectOption('#example', 'list');
  await page.waitForFunction(() => document.querySelector('#out-js').textContent.includes('todo-list'));
  const list = await frame(page, 'html');
  await list.fill('todo-list input', 'Tell a friend');
  await list.click('todo-list button');
  await list.waitForFunction(() => document.querySelectorAll('todo-list li').length === 3);
  await list.click('todo-list li >> nth=1');
  await list.waitForFunction(() => document.querySelector('todo-list p').textContent === '1 left');
  assert.deepEqual(errors, []);
  await page.close();
});
