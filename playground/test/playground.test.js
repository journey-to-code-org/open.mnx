// The playground in Chromium: it compiles in the page (zubra.wasm when built, else the test
// server's native compiler), runs the component in each preview, shows every output, reports
// errors, and keeps the example in a link. `node --test playground/test/`.
// With ZUBRA_REQUIRE_WASM=1, the site must have zubra.wasm and the page must use it.
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
const wasm = process.env.ZUBRA_REQUIRE_WASM === '1';
// React and Vue previews need examples/frameworks' toolchain (`npm ci` there).
const frameworks = existsSync(join(repo, 'examples/frameworks/node_modules/react'));
const out = join(here, '.tmp/site');

let server, browser;
before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  execFileSync(process.execPath, [join(here, '../build.mjs'), '--out', out, ...(wasm ? ['--require-wasm'] : []), ...(frameworks ? [] : ['--no-frameworks'])], { stdio: 'inherit' });
  server = await serve(out, { compiler: join(repo, 'target/debug/zubra') });
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

// The preview's frame, once it's running. A newer compile replaces the previews, so a frame found
// just before that is detached: then look again.
const frame = async (page, kind) => {
  for (let attempt = 0; ; attempt++) {
    const handle = await page.waitForSelector(`[data-preview=${kind}] iframe`);
    const content = await handle.contentFrame();
    try {
      if (!content) throw new Error('detached');
      await content.waitForFunction(() => window.previewReady === true);
      return content;
    } catch (error) {
      if (attempt > 20 || !/detached/i.test(String(error?.message))) throw error;
    }
  }
};

/** Chooses an example and waits for its preview: the one running before it is replaced, not reused. */
async function choose(page, example) {
  await page.evaluate(() => document.querySelectorAll('[data-preview] iframe').forEach((frame) => { frame.dataset.before = ''; }));
  await page.selectOption('#example', example);
  await page.waitForSelector('[data-preview=html] iframe:not([data-before])');
}

test('compiles in the page and runs the component in every preview', async () => {
  const { page, errors } = await openPlayground();
  assert.equal(await page.textContent('#status'), `Compiled (${wasm ? 'WebAssembly' : existsSync(join(out, 'zubra.wasm')) ? 'WebAssembly' : 'server'})`);
  const html = await frame(page, 'html');
  assert.deepEqual(await html.$$eval('hello-counter output', (els) => els.map((el) => el.textContent)), ['Apples: 0', 'Clicks: 5']);
  await html.click('hello-counter >> nth=0 >> button.more');
  await html.waitForFunction(() => document.querySelector('hello-counter output').textContent === 'Apples: 1');

  const kinds = await page.$$eval('[data-preview]', (els) => els.map((el) => el.dataset.preview));
  assert.deepEqual(kinds, frameworks ? ['html', 'react', 'vue'] : ['html']);
  // The page's two elements, with their attributes as props, in every framework.
  for (const kind of kinds.slice(1)) {
    const preview = await frame(page, kind);
    await preview.waitForSelector('hello-counter output');
    assert.deepEqual(await preview.$$eval('hello-counter output', (els) => els.map((el) => el.textContent)), ['Apples: 0', 'Clicks: 5'], kind);
    await preview.click('hello-counter >> nth=0 >> button.more');
    await preview.waitForFunction(() => document.querySelector('hello-counter output').textContent === 'Apples: 1');
  }

  // Every output, in its tab.
  await page.click('[role=tab][data-tab=js]');
  assert.match(await page.textContent('#out-js'), /\$define\(tag, \{/);
  // The custom element as you'd write it by hand: a class, not the runtime's definition.
  await page.click('[role=tab][data-tab=element]');
  const element = await page.textContent('#out-element');
  assert.match(element, /export class HelloCounter extends HTMLElement \{/);
  assert.match(element, /static observedAttributes = /);
  assert.match(element, /customElements\.define\(tag, HelloCounter\)/);
  assert.doesNotMatch(element, /\$define|@zubra\/runtime"/);
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
  assert.match(await page.textContent('#error'), /component\.zb:\d+:\d+/);
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

test('the examples: slots with hasSlot, a list with directives, a spread, and conditions', async () => {
  const { page, errors } = await openPlayground();
  await page.selectOption('#example', 'slots');
  await page.waitForFunction(() => document.querySelector('#out-js').textContent.includes('info-card'));
  const cards = await frame(page, 'html');
  assert.deepEqual(await cards.$$eval('info-card', (els) => els.map((el) => !!el.querySelector('footer'))), [true, false]);
  // The same slots in React and Vue: the footer goes to the named slot, the body to the default one.
  for (const kind of frameworks ? ['react', 'vue'] : []) {
    const preview = await frame(page, kind);
    await preview.waitForSelector('info-card');
    assert.deepEqual(await preview.$$eval('info-card', (els) => els.map((el) => !!el.querySelector('footer'))), [true, false], kind);
    assert.deepEqual(await preview.$$eval('info-card', (els) => els.map((el) => el.querySelector('p')?.textContent)), ['Body text.', 'No footer here.'], kind);
  }

  await page.selectOption('#example', 'list');
  await page.waitForFunction(() => document.querySelector('#out-js').textContent.includes('todo-list'));
  const list = await frame(page, 'html');
  await list.fill('todo-list input', 'Tell a friend');
  await list.click('todo-list button');
  await list.waitForFunction(() => document.querySelectorAll('todo-list li').length === 3);
  await list.click('todo-list li >> nth=1');
  await list.waitForFunction(() => document.querySelector('todo-list p').textContent === '1 left');

  // A spread: the preview loads @zubra/runtime/spread through the import map.
  await page.selectOption('#example', 'spread');
  await page.waitForFunction(() => document.querySelector('#out-js').textContent.includes('@zubra/runtime/spread'));
  const panel = await frame(page, 'html');
  await panel.waitForFunction(() => document.querySelector('disclosure-panel button')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await panel.$eval('disclosure-panel [role=region]', (el) => el.hidden), true);
  await panel.click('disclosure-panel button');
  await panel.waitForFunction(() => document.querySelector('disclosure-panel button').getAttribute('aria-expanded') === 'true');
  assert.equal(await panel.$eval('disclosure-panel [role=region]', (el) => el.hidden), false);

  // Conditions as attributes, and markup in braces.
  await page.selectOption('#example', 'conditions');
  await page.waitForFunction(() => document.querySelector('#out-js').textContent.includes('cart-summary'));
  const cart = await frame(page, 'html');
  await cart.waitForFunction(() => document.querySelector('cart-summary p')?.textContent === 'Your cart is empty.');
  for (let i = 0; i < 3; i++) await cart.click('cart-summary button');
  await cart.waitForFunction(() => document.querySelectorAll('cart-summary li').length === 3);
  assert.equal(await cart.$eval('cart-summary p', (el) => el.textContent), "That's a full cart.");
  assert.equal(await cart.$eval('cart-summary strong', (el) => el.textContent), 'Free shipping!');
  assert.deepEqual(errors, []);
  await page.close();
});

test("'use collection': the note is kept on the device, through a reload", async () => {
  const { page, errors } = await openPlayground();
  await choose(page, 'sync');
  assert.match(await page.textContent('#out-js'), /@zubra\/sync/);
  const pad = await frame(page, 'html');
  await pad.waitForFunction(() => document.querySelector('note-pad p')?.textContent === '0 words');
  await pad.fill('note-pad textarea', 'kept on the device');
  await pad.waitForFunction(() => document.querySelector('note-pad p').textContent.startsWith('4 words'));
  // Ephemeral: focus shows, and isn't what's stored.
  assert.match(await pad.textContent('note-pad p'), /editing/);
  // Stored: wait for IndexedDB to have it, then reload.
  await pad.waitForFunction(() => new Promise((resolve) => {
    const open = indexedDB.open('zubra-sync', 1);
    open.onsuccess = () => {
      const get = open.result.transaction('docs').objectStore('docs').get(['notes', 'playground']);
      get.onsuccess = () => { open.result.close(); resolve(get.result?.text === 'kept on the device'); };
      get.onerror = () => resolve(false);
    };
    open.onerror = () => resolve(false);
  }), null, { polling: 100 });

  await page.reload();
  await page.waitForFunction(() => window.playgroundReady === true);
  // The link already holds the note-pad, so choosing it compiles it again and replaces the preview
  // that's running: wait for the new one, not the one about to be removed.
  await choose(page, 'sync');
  const again = await frame(page, 'html');
  await again.waitForFunction(() => document.querySelector('note-pad textarea')?.value === 'kept on the device');
  assert.equal(await again.textContent('note-pad p'), '4 words');
  assert.deepEqual(errors, []);
  await page.close();
});

test("'use server': the Server tab has the function, and a submit says what would be posted", async () => {
  // The guide links here by name.
  const { page, errors } = await openPlayground('#example=actions');
  assert.equal(await page.inputValue('#example'), 'actions');
  await page.waitForFunction(() => document.querySelector('#out-server').textContent.includes('export async function subscribe(formData)'));
  await page.selectOption('#example', 'counter');
  await page.click('[data-tab=server]');
  await page.waitForFunction(() => document.querySelector('#out-server').textContent.includes("No 'use server' functions"));
  await page.selectOption('#example', 'actions');
  await page.waitForFunction(() => document.querySelector('#out-server').textContent.includes('export async function subscribe(formData)'));
  const js = await page.textContent('#out-js');
  assert.match(js, /const subscribe = "\/_zb\/action\/newsletter-signup\/subscribe"/);
  assert.doesNotMatch(js, /doesn't look like an email/);
  await page.click('[data-tab=preview]');
  const form = await frame(page, 'html');
  await form.fill('newsletter-signup input', 'ada@example.com');
  await form.click('newsletter-signup button');
  await form.waitForSelector('.zb-playground-post');
  assert.match(await form.textContent('.zb-playground-post'), /^POST \/_zb\/action\/newsletter-signup\/subscribe \(email=ada@example\.com\)/);
  assert.equal(form.url(), 'about:srcdoc', 'the page stayed');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the source and the output are coloured, and the docs link goes to the docs site', async () => {
  const { page, errors } = await openPlayground();
  // The editor's text is drawn by a <pre> behind the textarea; it has the same text, in coloured spans.
  const behind = page.locator('.editor pre').first();
  assert.ok((await behind.locator('.tok-k').count()) > 0, 'keywords in the script');
  assert.ok((await behind.locator('.tok-t').count()) > 0, 'tags in the template');
  assert.equal((await behind.innerText()).trimEnd(), (await page.inputValue('#source')).trimEnd(), 'the same text as the textarea');
  // Typing redraws it.
  await page.fill('#source', '<script>\n  const answer = 42\n</script>\n<x-y></x-y>');
  await page.waitForFunction(() => document.querySelector('.editor pre .tok-n')?.textContent === '42');
  // The compiled output is coloured too.
  await page.click('[data-tab=js]');
  await page.waitForFunction(() => document.querySelector('#out-js .tok-k'));
  assert.equal(await page.getAttribute('#docs-link', 'href'), '../docs/');
  assert.deepEqual(errors, []);
  await page.close();
});

test('the Zubra DevTools extension works on the playground: its hook reaches the previews, and a line opens in the editor', async () => {
  const { page, errors } = await openPlayground();
  await frame(page, 'html');
  // As the extension calls it, on the page it inspects: connect, then inspect the selected node.
  const result = await page.evaluate(async () => {
    const hook = globalThis.__ZUBRA_DEVTOOLS__;
    hook.connect();
    for (let i = 0; i < 100 && !hook.ready; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const preview = document.querySelector('[data-preview=html] iframe').contentDocument;
    const output = preview.querySelector('hello-counter output');
    const before = hook.inspect(output);
    preview.querySelector('hello-counter button.more').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = hook.inspect(output);
    return {
      tag: before.component.tag,
      located: before.component.located,
      here: before.bindings.filter((binding) => binding.here).map(({ operation, at, dependsOn }) => ({ operation, line: at?.line, dependsOn })),
      written: after.lastUpdate.written,
      updates: hook.updates,
      outside: hook.inspect(document.body).component,
    };
  });
  assert.deepEqual(result, {
    tag: 'hello-counter', located: true,
    here: [{ operation: 'textContent = …', line: 15, dependsOn: ['label', 'count'] }],
    written: ['count'], updates: 1, outside: null,
  });
  // The Runtime module tab is still the plain build: the DevTools fields are only in the preview.
  assert.doesNotMatch(await page.$eval('#out-js', (pre) => pre.textContent), /\bat: \[|\$dev/);

  // "Open in editor" from the pane: the frame's own hook (newer extensions read it) and the
  // page's both select the line in the source.
  const selected = () => page.$eval('#source', (area) => area.value.slice(area.selectionStart, area.selectionEnd));
  await page.evaluate(() => document.querySelector('[data-preview=html] iframe').contentWindow.__ZUBRA_DEVTOOLS__.open('/playground/component.zb', 15, 3));
  assert.equal(await selected(), '  <output>{label}: {count}</output>');
  await page.evaluate(() => globalThis.__ZUBRA_DEVTOOLS__.open('/playground/component.zb', 16, 3));
  assert.match(await selected(), /^  <button type="button" class="more"/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('after a compile error the tabs show it and the preview is marked old; an empty source clears everything', async () => {
  const { page } = await openPlayground();
  await frame(page, 'html');
  const stale = () => page.$eval('.pane.output', (pane) => pane.hasAttribute('data-stale'));
  const edit = (change) => page.$eval('#source', (area, change) => { area.value = (0, eval)(`(${change})`)(area.value); area.dispatchEvent(new Event('input')); }, change);
  assert.equal(await stale(), false);

  await edit(`(v) => v.replace(' label="Clicks"', '')`);
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Compile error');
  assert.equal(await stale(), true);
  assert.match(await page.textContent('#error'), /unknown reference `label`/);
  assert.match(await page.textContent('#out-js'), /^\/\/ Doesn't compile yet:[\s\S]*unknown reference `label`/, 'not the old module');
  assert.match(await page.textContent('#out-element'), /Doesn't compile yet/);
  assert.equal(await page.$eval('#previews', (box) => getComputedStyle(box).opacity), '0.4');

  await edit(`(v) => v.replace('<hello-counter count:model={0}>', '<hello-counter count:model={0} label="Taps">')`);
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Compiled'));
  assert.equal(await stale(), false);
  assert.match(await page.textContent('#out-js'), /Taps/);

  await edit(`() => ''`);
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Empty');
  assert.equal(await page.$('#previews iframe'), null, 'no preview of the old component');
  assert.match(await page.textContent('#previews'), /Nothing to preview yet/);
  assert.match(await page.textContent('#out-js'), /Nothing to compile yet/);
  assert.equal(await page.$eval('#error', (box) => box.hidden), true);
  assert.equal(await stale(), false);
  await page.close();
});

test('every example in the picker compiles and renders in every preview', async () => {
  const { page, errors } = await openPlayground();
  const keys = await page.$$eval('#example option', (options) => options.map((option) => option.value));
  assert.equal(keys.length, 11, 'the picker lists every example');
  for (const key of keys) {
    await choose(page, key);
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Compiled'), null, { timeout: 15000 });
    assert.equal(await page.$eval('#error', (box) => box.hidden), true, key);
    const html = await frame(page, 'html');
    assert.ok((await html.textContent('body')).trim().length > 0, `${key} renders in plain HTML`);
    for (const kind of frameworks ? ['react', 'vue'] : []) {
      const preview = await frame(page, kind);
      assert.ok((await preview.textContent('body')).trim().length > 0, `${key} renders in ${kind}`);
    }
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('the new examples: a form control validates and resets, data loads, events fire, typed props clamp', async () => {
  const { page, errors } = await openPlayground();

  // A form control: required and minimum length run with the form; reset returns it to empty.
  await choose(page, 'forms');
  for (const kind of ['html', ...(frameworks ? ['react', 'vue'] : [])]) {
    const preview = await frame(page, kind);
    const input = preview.locator('text-field input');
    await input.waitFor();
    await input.fill('Al');
    await input.press('Tab');
    await preview.waitForFunction(() => document.querySelector('text-field .error').textContent.includes('At least 3'));
    assert.equal(await input.getAttribute('aria-invalid'), 'true', kind);
    await preview.locator('button[type=reset]').click();
    await preview.waitForFunction(() => document.querySelector('text-field input').value === '');
    assert.equal((await preview.locator('text-field .error').textContent()).trim(), '', kind);
  }

  // Data that loads: the quote arrives, and "Another" loads a different one.
  await choose(page, 'async');
  const quotes = await frame(page, 'html');
  await quotes.waitForSelector('quote-card blockquote');
  const first = await quotes.locator('quote-card blockquote').textContent();
  await quotes.locator('quote-card button').click();
  await quotes.waitForFunction((was) => document.querySelector('quote-card blockquote')?.textContent !== was, first);

  // Events: assigning the model prop fires valuechange; Clear fires clear.
  await choose(page, 'events');
  const rating = await frame(page, 'html');
  await rating.locator('star-rating').nth(0).waitFor();
  await rating.evaluate(() => {
    window.log = [];
    const el = document.querySelector('star-rating');
    el.addEventListener('valuechange', (event) => window.log.push(['valuechange', event.detail]));
    el.addEventListener('clear', (event) => window.log.push(['clear', event.detail]));
  });
  const readout = async () => (await rating.locator('star-rating').nth(0).locator('output').textContent()).replace(/\s+/g, ' ').trim();
  // The first rating starts at 3, so the fourth star is the change.
  await rating.locator('star-rating').nth(0).locator('button').nth(3).click();
  assert.equal(await readout(), '4 of 5');
  await rating.locator('star-rating').nth(0).locator('button.clear').click();
  assert.equal(await readout(), '0 of 5');
  assert.deepEqual(await rating.evaluate(() => window.log), [['valuechange', 4], ['valuechange', 0], ['clear', 0]]);

  // Typed props: a null value reads as "No value"; +10 and −10 clamp to 0 and 100.
  await choose(page, 'typescript');
  for (const kind of ['html', ...(frameworks ? ['react', 'vue'] : [])]) {
    const meter = await frame(page, kind);
    assert.deepEqual((await meter.locator('meter-bar output').allTextContents()).map((text) => text.trim()), ['40%', 'No value'], kind);
  }
  const meter = await frame(page, 'html');
  const second = meter.locator('meter-bar').nth(1);
  await second.locator('button').nth(1).click();
  assert.equal((await second.locator('output').textContent()).trim(), '10%');
  await second.locator('button').nth(0).click();
  assert.equal((await second.locator('output').textContent()).trim(), '0%');
  assert.equal(await second.locator('button').nth(0).isDisabled(), true, 'clamped at zero');
  const firstMeter = meter.locator('meter-bar').nth(0);
  for (let i = 0; i < 6; i++) await firstMeter.locator('button').nth(1).click();
  assert.equal((await firstMeter.locator('output').textContent()).trim(), '100%');
  assert.equal(await firstMeter.locator('button').nth(1).isDisabled(), true, 'clamped at the maximum');
  assert.deepEqual(errors, []);
  await page.close();
});
