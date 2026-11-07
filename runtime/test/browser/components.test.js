// End-to-end: .mnx files compiled by the Rust CLI, run in Chromium. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, repo, site } from './harness.js';

useBrowser({
  header: join(repo, 'examples/header.mnx'),
  counter: join(here, 'fixtures/counter.mnx'),
  link: join(here, 'fixtures/link.mnx'),
  greeting: join(here, 'fixtures/greeting.mnx'),
  pair: join(here, 'fixtures/pair.mnx'),
  typed: join(here, 'fixtures/typed.mnx'),
  clock: join(here, 'fixtures/clock.mnx'),
});

// ---- fresh rendering and updates -----------------------------------------------------------

test('renders from its defaults and updates when props change', async () => {
  const { page, messages } = await open('<mnx-header></mnx-header>', { modules: ['header'] });
  const read = () => page.$$eval('mnx-header h1, mnx-header li', (nodes) => nodes.map((node) => node.textContent));
  assert.deepEqual(await read(), ['Mikey Nichols', 'sample data', 'additional data']);

  await page.evaluate(async () => {
    const el = document.querySelector('mnx-header');
    el.title = 'Journey to Code';
    el.data = { sample: 'one', sampleTwo: 'two' };
    await el.updateComplete;
  });
  assert.deepEqual(await read(), ['Journey to Code', 'one', 'two']);

  await page.evaluate(async () => {
    const el = document.querySelector('mnx-header');
    el.setAttribute('data', '{"sample":"from","sampleTwo":"json"}');
    await el.updateComplete;
  });
  assert.deepEqual(await read(), ['Journey to Code', 'from', 'json'], 'array/object attributes are parsed as JSON');
  assert.deepEqual(messages, []);
  await page.close();
});

test('batches several writes into one DOM update', async () => {
  const { page } = await open('<mnx-header></mnx-header>', { modules: ['header'] });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('mnx-header');
    const h1 = el.querySelector('h1');
    let mutations = 0;
    new MutationObserver((records) => { mutations += records.length; }).observe(h1, { childList: true, characterData: true, subtree: true });
    el.title = 'a'; el.title = 'b'; el.title = 'c';
    const sync = h1.textContent;
    await el.updateComplete;
    await new Promise((resolve) => setTimeout(resolve));
    return { sync, after: h1.textContent, mutations };
  });
  assert.equal(result.sync, 'Mikey Nichols', 'writes are applied in a microtask, not synchronously');
  assert.equal(result.after, 'c');
  assert.equal(result.mutations, 1);
  await page.close();
});

test('keeps properties set before the element was defined', async () => {
  const { page } = await open('<mnx-header></mnx-header>', {
    beforeModules: `document.querySelector('mnx-header').title = 'Set early';`,
    modules: ['header'],
  });
  assert.equal(await page.$eval('mnx-header h1', (h1) => h1.textContent), 'Set early');
  await page.close();
});

// ---- hydration -----------------------------------------------------------------------------

test('hydrates server markup in place, keeping every node', async () => {
  const props = join(site, 'header.props.json');
  writeFileSync(props, JSON.stringify({ title: 'From the server', data: { sample: 's1', sampleTwo: 's2' } }));
  const html = compiler(join(repo, 'examples/header.mnx'), '--props', props);
  const { page, messages } = await open(html, {
    beforeModules: `
      window.before = [...document.querySelectorAll('mnx-header *')];
      window.textBefore = document.querySelector('mnx-header h1').firstChild;`,
    modules: ['header'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('mnx-header');
    const after = [...el.querySelectorAll('*')];
    const sameNodes = after.length === window.before.length && after.every((node, i) => node === window.before[i]);
    const sameText = el.querySelector('h1').firstChild === window.textBefore;
    const props = { title: el.title, data: el.data };
    el.title = 'Updated';
    await el.updateComplete;
    return { sameNodes, sameText, props, h1: el.querySelector('h1').textContent, h1Same: el.querySelector('h1') === window.before[2] };
  });
  assert.equal(result.sameNodes, true, 'every element is the one the server sent');
  assert.equal(result.sameText, true, 'unchanged text is not rewritten');
  assert.deepEqual(result.props, { title: 'From the server', data: { sample: 's1', sampleTwo: 's2' } }, 'props come back from the host attributes');
  assert.equal(result.h1, 'Updated');
  assert.equal(result.h1Same, true);
  assert.deepEqual(messages, []);
  await page.close();
});

test('hydrates dynamic text beside other nodes through its anchor', async () => {
  const html = compiler(join(here, 'fixtures/greeting.mnx'));
  assert.match(html, /<b>there<\/b><!---->, Ada! <i>glad<\/i>/);
  const { page, messages } = await open(html, {
    beforeModules: `window.p = document.querySelector('mnx-greeting p'); window.nodes = [...window.p.childNodes];`,
    modules: ['greeting'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('mnx-greeting');
    const same = [...window.p.childNodes].every((node, i) => node === window.nodes[i]);
    el.name = 'Grace';
    el.mood = 'happy';
    await el.updateComplete;
    const afterName = el.querySelector('p').textContent;
    el.name = '';
    await el.updateComplete;
    const empty = el.querySelector('p').textContent;
    el.name = 'Back';
    await el.updateComplete;
    return { same, afterName, empty, back: el.querySelector('p').textContent };
  });
  assert.equal(result.same, true);
  assert.equal(result.afterName, 'Hello there, Grace! happy to see you.');
  assert.equal(result.empty, 'Hello there, ! happy to see you.');
  assert.equal(result.back, 'Hello there, Back! happy to see you.');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a fresh element with anchored text renders it too', async () => {
  const { page } = await open('<mnx-greeting name="Linus"></mnx-greeting>', { modules: ['greeting'] });
  assert.equal(await page.$eval('mnx-greeting p', (p) => p.textContent), 'Hello there, Linus! glad to see you.');
  await page.close();
});

test('markup that does not match the template is re-rendered, with a warning', async () => {
  const { page, messages } = await open('<mnx-header><p>stale markup</p></mnx-header>', { modules: ['header'] });
  assert.equal(await page.$eval('mnx-header h1', (h1) => h1.textContent), 'Mikey Nichols');
  assert.equal(await page.$('mnx-header > p'), null);
  assert.ok(messages.some((message) => message.startsWith('warning:') && message.includes("doesn't match its template")));
  await page.close();
});

test('markup whose parts would line up but whose shape differs is re-rendered too', async () => {
  // Every part finds a <button> at its path, but the server never rendered the extra <p>.
  const { page, messages } = await open('<mnx-counter><button type="button">x</button><p>extra</p></mnx-counter>', { modules: ['counter'] });
  assert.equal(await page.$('mnx-counter > p'), null);
  assert.equal(await page.$eval('mnx-counter button', (button) => button.textContent), 'Clicks: 0');
  assert.ok(messages.some((message) => message.includes("doesn't match its template")));
  await page.close();
});

test('a template with several top-level nodes renders, hydrates and updates', async () => {
  const read = (page) => page.$eval('mnx-pair', (pair) => pair.innerHTML.replace(/<!--.*?-->/g, ''));
  const fresh = await open('<mnx-pair></mnx-pair>', { modules: ['pair'] });
  assert.equal(await read(fresh.page), 'Hi Ada <p>x</p><i>y</i>');
  await fresh.page.close();

  const props = join(site, 'pair.props.json');
  writeFileSync(props, JSON.stringify({ name: 'Lin' }));
  const server = compiler(join(here, 'fixtures/pair.mnx'), '--props', props);
  const { page, messages } = await open(server, { modules: ['pair'] });
  await page.evaluate(() => { window.p = document.querySelector('mnx-pair p'); });
  await page.evaluate(async () => {
    const pair = document.querySelector('mnx-pair');
    pair.name = 'Grace';
    pair.on = false;
    await pair.updateComplete;
  });
  assert.equal(await read(page), 'Hi Grace <p>x</p>');
  assert.equal(await page.evaluate(() => window.p === document.querySelector('mnx-pair p')), true, 'hydrated, not re-rendered');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a component written in TypeScript runs as its JavaScript', async () => {
  const { page, messages } = await open('<mnx-typed></mnx-typed>', {
    beforeModules: "window.picks = []; document.addEventListener('pick', (event) => window.picks.push(event.detail));",
    modules: ['typed'],
  });
  assert.equal(await page.textContent('mnx-typed p'), 'none');
  await page.click('mnx-typed li[data-index="1"]');
  await page.evaluate(() => document.querySelector('mnx-typed').updateComplete);
  assert.equal(await page.textContent('mnx-typed p'), '#1');
  assert.deepEqual(await page.evaluate(() => window.picks), [{ option: { id: 2, label: '?' }, index: 1 }]);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a default computed by the script applies unless the prop was given', async () => {
  const { page, messages } = await open(
    '<mnx-clock id="a"></mnx-clock><mnx-clock id="b" since="5"></mnx-clock><mnx-clock id="c"></mnx-clock>',
    { beforeModules: "window.clockStart = 42; document.getElementById('c').since = 7;", modules: ['clock'] },
  );
  const text = (id) => page.$eval(`#${id} p`, (p) => p.textContent);
  assert.equal(await text('a'), 'Clock: 42 UTC', 'computed in the browser, per element');
  assert.equal(await text('b'), 'Clock: 5 UTC', 'an attribute wins');
  assert.equal(await text('c'), 'Clock: 7 UTC', 'a property set before the element was defined wins');
  await page.evaluate(async () => { const a = document.getElementById('a'); a.since = 9; await a.updateComplete; });
  assert.equal(await text('a'), 'Clock: 9 UTC');
  assert.deepEqual(messages, []);
  await page.close();
});

// ---- state, events, lifecycle --------------------------------------------------------------

test('state() in the script and an onclick handler make a working counter', async () => {
  const { page, messages } = await open('<mnx-counter></mnx-counter>', { modules: ['counter'] });
  const button = page.locator('mnx-counter button');
  assert.equal(await button.textContent(), 'Clicks: 0');
  await button.click();
  await button.click();
  await button.click();
  assert.equal(await button.textContent(), 'Clicks: 3');
  await page.evaluate(async () => {
    const el = document.querySelector('mnx-counter');
    el.label = 'Taps';
    await el.updateComplete;
  });
  assert.equal(await button.textContent(), 'Taps: 3', 'state survives prop changes');
  assert.deepEqual(messages, []);
  await page.close();
});

test('mount/unmount hooks run on connect and disconnect; state survives a move', async () => {
  const { page } = await open('<mnx-counter></mnx-counter><section></section>', { modules: ['counter'] });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('mnx-counter');
    el.querySelector('button').click();
    await el.updateComplete;
    el.remove();
    el.label = 'While away';
    await el.updateComplete;
    const whileAway = el.querySelector('button').textContent;
    document.querySelector('section').append(el);
    await el.updateComplete;
    return { log: window.lifecycle, whileAway, back: el.querySelector('button').textContent };
  });
  assert.deepEqual(result.log, ['mount', 'mount cleanup', 'unmount', 'mount']);
  assert.equal(result.whileAway, 'Clicks: 1', 'a detached element does not update');
  assert.equal(result.back, 'While away: 1', 'on return it catches up, keeping its state');
  await page.close();
});

// ---- safety and attributes -----------------------------------------------------------------

test('blocks unsafe URLs at runtime and handles boolean and interpolated attributes', async () => {
  const { page, messages } = await open('<mnx-link></mnx-link>', { modules: ['link'] });
  const read = () => page.$eval('mnx-link a', (a) => ({ href: a.getAttribute('href'), hidden: a.hidden, className: a.className }));
  assert.deepEqual(await read(), { href: '/', hidden: false, className: 'link Home' });

  await page.evaluate(async () => {
    const el = document.querySelector('mnx-link');
    el.href = 'javascript:alert(1)';
    el.hiddenLink = true;
    el.label = 'Away';
    await el.updateComplete;
  });
  assert.deepEqual(await read(), { href: null, hidden: true, className: 'link Away' });
  assert.ok(messages.some((message) => message.startsWith('error:') && message.includes('blocked an unsafe URL')));

  await page.evaluate(async () => {
    const el = document.querySelector('mnx-link');
    el.href = 'https://mnix.dev/';
    el.setAttribute('hidden-link', '');
    await el.updateComplete;
  });
  assert.deepEqual(await read(), { href: 'https://mnix.dev/', hidden: true, className: 'link Away' });
  await page.evaluate(async () => {
    const el = document.querySelector('mnx-link');
    el.removeAttribute('hidden-link');
    await el.updateComplete;
  });
  assert.equal((await read()).hidden, false, 'kebab-case attributes map to camelCase props');
  await page.close();
});
