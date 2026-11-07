// End-to-end: .mnx files compiled by the Rust CLI, run in Chromium. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, repo, site } from './harness.js';

useBrowser({
  filters: join(here, 'fixtures/live-filters.mnx'),
  header: join(repo, 'examples/header.mnx'),
  counter: join(here, 'fixtures/counter.mnx'),
  link: join(here, 'fixtures/link.mnx'),
  greeting: join(here, 'fixtures/greeting.mnx'),
  pair: join(here, 'fixtures/pair.mnx'),
  typed: join(here, 'fixtures/typed.mnx'),
  clock: join(here, 'fixtures/clock.mnx'),
  inline: join(here, 'fixtures/inline.mnx'),
  state: join(here, 'fixtures/state.mnx'),
  'row-counter': join(here, 'fixtures/row-counter.mnx'),
  'row-list': join(here, 'fixtures/row-list.mnx'),
  'mnx-model-input': join(here, 'fixtures/model-input.mnx'),
  'mnx-sugar': join(here, 'fixtures/sugar.mnx'),
  'svg-dots': join(here, 'fixtures/svg-dots.mnx'),
  'pick-list': join(here, 'fixtures/pick-list.mnx'),
  'slot-card': join(here, 'fixtures/slot-card.mnx'),
  'slot-card-shadow': join(here, 'fixtures/slot-card-shadow.mnx'),
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

test('inline JavaScript in the template: calls, handlers that close over list items, emit()', async () => {
  const { page, messages } = await open('<mnx-inline></mnx-inline>', { modules: ['inline'] });
  const read = () => page.evaluate(() => ({
    summary: document.querySelector('.summary').textContent,
    rows: [...document.querySelectorAll('mnx-inline li')].map((li) => li.textContent),
  }));
  assert.deepEqual(await read(), { summary: '2 of 3; none', rows: ['#2 LINUS', '#3 GRACE'] });
  assert.deepEqual(await page.evaluate(() => customElements.get('mnx-inline').mnx.events), ['pick']);
  assert.equal(await page.evaluate(() => typeof document.querySelector('mnx-inline').stamp), 'number', 'a default computed in the browser');

  await page.evaluate(() => document.querySelector('mnx-inline').addEventListener('pick', (event) => { window.picked = event.detail; }));
  await page.click('mnx-inline li:last-child');
  await page.evaluate(() => document.querySelector('mnx-inline').updateComplete);
  assert.equal(await page.evaluate(() => window.picked), 3, 'the handler saw its own row');
  assert.equal((await read()).summary, '2 of 3; grace', 'a state() read with .get() in the template is reactive');

  await page.click('mnx-inline .raise');
  await page.evaluate(() => document.querySelector('mnx-inline').updateComplete);
  assert.deepEqual(await read(), { summary: '1 of 3; grace', rows: ['#3 GRACE'] }, 'a handler assigned a prop');
  assert.equal(await page.evaluate(() => document.querySelector('mnx-inline').min), 2);
  assert.deepEqual(messages, []);
  await page.close();
});

test('partially server-rendered markup: the element fills in what only the browser could compute', async () => {
  // --partial leaves JavaScript expressions empty and their regions marked <!--[?-->.
  const html = compiler(join(here, 'fixtures/inline.mnx'), '--partial');
  assert.match(html, /<!--\[\?--><!--\]-->/);
  const { page, messages } = await open(html, { modules: ['inline'], beforeModules: "window.serverButton = document.querySelector('mnx-inline .raise');" });
  await page.evaluate(() => document.querySelector('mnx-inline').updateComplete);
  const read = () => page.evaluate(() => ({
    summary: document.querySelector('.summary').textContent,
    rows: [...document.querySelectorAll('mnx-inline li')].map((li) => li.textContent),
  }));
  assert.deepEqual(await read(), { summary: '2 of 3; none', rows: ['#2 LINUS', '#3 GRACE'] });
  assert.equal(await page.evaluate(() => document.querySelector('mnx-inline .raise') === window.serverButton), true, 'the server markup was kept');
  await page.click('mnx-inline li:last-child');
  await page.evaluate(() => document.querySelector('mnx-inline').updateComplete);
  assert.equal((await read()).summary, '2 of 3; grace', 'and it works as usual');
  assert.deepEqual(messages, [], 'no hydration warnings');
  await page.close();
});

test("2.0's script: a let is state, a derived const follows it, and props are names", async () => {
  const html = compiler(join(here, 'fixtures/state.mnx'), '--partial');
  assert.match(html, /<button type="button" class="add">n: 0<\/button>\n  <i>1<\/i>/, 'server-rendered from the initial values');
  const { page, messages } = await open(html, { modules: ['state'] });
  const read = () => page.evaluate(async () => {
    const el = document.querySelector('mnx-state');
    await el.updateComplete;
    return [el.querySelector('.add').textContent, el.querySelector('i').textContent, el.querySelector('b').textContent];
  });
  assert.deepEqual(await read(), ['n: 0', '1', '1']);
  await page.evaluate(() => { window.counts = []; document.querySelector('mnx-state').addEventListener('countchange', (event) => window.counts.push(event.detail)); });
  await page.click('mnx-state .add');
  assert.deepEqual(await read(), ['n: 1', '3', '1']);
  await page.click('mnx-state b');
  assert.deepEqual(await read(), ['n: 2', '5', '2'], 'an inline handler updated the state');
  await page.evaluate(() => { document.querySelector('mnx-state').step = 4; });
  assert.deepEqual(await read(), ['n: 2', '8', '2'], 'the derived value follows the prop');
  await page.click('mnx-state .add');
  assert.deepEqual(await read(), ['big: 6', '16', '6'], 'the script assigned a prop by its name');
  assert.equal(await page.evaluate(() => document.querySelector('mnx-state').label), 'big');
  assert.deepEqual(await page.evaluate(() => window.counts), [1, 6]);
  assert.deepEqual(messages, []);
  await page.close();
});

test('an element a list adds keeps working when the list changes again, and value follows its state', async () => {
  const { page, messages } = await open('<row-list></row-list>', { modules: ['row-counter', 'row-list'] });
  const settle = () => page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await Promise.all([...document.querySelectorAll('row-list, row-counter')].map((el) => el.updateComplete));
  });
  const add = async (name) => { await page.fill('row-list input', name); await page.press('row-list input', 'Enter'); await settle(); };
  await add('b');
  assert.equal(await page.inputValue('row-list input'), '', 'assigning the state cleared what was typed');
  await add('c'); // the list effect re-runs: the element it added for `b` must not be disposed with it
  await page.locator('row-counter button').nth(1).click();
  await settle();
  assert.deepEqual(await page.$$eval('row-counter button', (buttons) => buttons.map((button) => button.textContent)), ['a 0', 'b 1', 'c 0']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a <select> bound to a value takes it when its options come from a list inside it', async () => {
  const { page, messages } = await open('<pick-list></pick-list>', { modules: ['pick-list'] });
  const settle = () => page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await document.querySelector('pick-list').updateComplete;
  });
  await settle();
  assert.equal(await page.inputValue('pick-list select'), 'large');
  await page.selectOption('pick-list select', 'small');
  await settle();
  assert.equal(await page.textContent('pick-list output'), 'small');
  await page.click('pick-list button');
  await settle();
  assert.equal(await page.inputValue('pick-list select'), 'medium');
  assert.deepEqual(messages, []);
  await page.close();
});

test('list rows and branches inside <svg> are SVG elements', async () => {
  const { page, messages } = await open('<svg-dots></svg-dots>', { modules: ['svg-dots'] });
  const shapes = () => page.$$eval('svg-dots svg > *', (els) => els.map((el) => `${el.localName}:${el.namespaceURI === 'http://www.w3.org/2000/svg'}`));
  assert.deepEqual(await shapes(), ['circle:true', 'circle:true']);
  await page.click('svg-dots button');
  await page.evaluate(() => document.querySelector('svg-dots').updateComplete);
  assert.deepEqual(await shapes(), ['circle:true', 'circle:true', 'circle:true', 'rect:true']);
  assert.ok(await page.$eval('svg-dots circle:last-of-type', (el) => el.getBBox().width > 0), 'it renders');
  assert.deepEqual(messages, []);
  await page.close();
});

test('2.2 template sugar: class and style directives, event modifiers, ref, global listeners, else-if', async () => {
  const { page, messages } = await open('<mnx-sugar></mnx-sugar>', { modules: ['mnx-sugar'] });
  const settle = () => page.evaluate(async () => { await new Promise((resolve) => setTimeout(resolve)); await document.querySelector('mnx-sugar').updateComplete; });
  const log = () => page.textContent('mnx-sugar output');
  const state = () => page.$eval('mnx-sugar p', (p) => ({ className: p.className, size: p.style.fontSize, tone: p.style.getPropertyValue('--tone') }));
  assert.deepEqual(await state(), { className: 'base', size: '10px', tone: 'red' });
  assert.equal(await page.$eval('mnx-sugar dialog', (dialog) => dialog.isConnected), true);

  // Modifiers: .prevent keeps the form from navigating; .self ignores clicks from inside.
  await page.click('mnx-sugar button:not(.change)');
  await page.click('mnx-sugar .inner');
  const outer = await page.locator('mnx-sugar .outer').boundingBox();
  await page.mouse.click(outer.x + outer.width - 4, outer.y + outer.height / 2);
  await page.focus('mnx-sugar input');
  await page.keyboard.press('a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Enter');
  // Document listeners: Shift+K and Escape, wherever focus is.
  await page.keyboard.press('k');
  await page.keyboard.press('Shift+K');
  await page.keyboard.press('Escape');
  await settle();
  // The button submits; the inner click is ignored, the outer one counted; Shift+Enter doesn't
  // match `.enter` (modifier keys are exact with a key filter) but still submits; Enter does both.
  assert.equal(await log(), 'submit,self,submit,enter,submit,K,esc');
  assert.equal(page.url().endsWith('.html'), true, 'the submit was prevented');

  // The change button: class and style follow state; null removes a property; else-if moves on.
  await page.click('mnx-sugar .change');
  await settle();
  assert.deepEqual(await state(), { className: 'base on big', size: '30px', tone: '' });
  assert.equal(await page.$eval('mnx-sugar', (el) => el.textContent.includes('B')), true);
  await page.click('mnx-sugar .change');
  await settle();
  assert.equal(await page.$eval('mnx-sugar', (el) => el.textContent.includes('C')), true);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a two-way prop fires <prop>change when the component assigns it, and is the form value', async () => {
  const { page, messages } = await open('<form><mnx-model-input name="qty"></mnx-model-input><button type="reset">reset</button></form>', { modules: ['mnx-model-input'] });
  await page.evaluate(() => {
    window.changes = [];
    document.querySelector('mnx-model-input').addEventListener('valuechange', (event) => window.changes.push(event.detail));
  });
  const settle = () => page.evaluate(() => document.querySelector('mnx-model-input').updateComplete);
  const data = () => page.evaluate(() => new FormData(document.querySelector('form')).get('qty'));
  assert.equal(await data(), '2');
  await page.click('mnx-model-input .up');
  await page.click('mnx-model-input .up');
  await page.click('mnx-model-input .down');
  await settle();
  assert.deepEqual(await page.evaluate(() => window.changes), [3, 4, 3]);
  assert.equal(await page.textContent('mnx-model-input output'), '3');
  assert.equal(await data(), '3');
  // Set from outside: no event (the caller knows), but the form value follows.
  await page.evaluate(() => { document.querySelector('mnx-model-input').value = 7; });
  await settle();
  assert.deepEqual(await page.evaluate(() => window.changes), [3, 4, 3]);
  assert.equal(await data(), '7');
  // A form reset restores the initial value, and says so.
  await page.click('button[type=reset]');
  await settle();
  assert.equal(await page.textContent('mnx-model-input output'), '2');
  assert.deepEqual(await page.evaluate(() => window.changes), [3, 4, 3, 2]);
  assert.deepEqual(messages, []);
  await page.close();
});

test('hasSlot() follows whether a slot has content, in light and shadow DOM', async () => {
  for (const tag of ['slot-card', 'slot-card-shadow']) {
    const { page, messages } = await open(`<${tag} id="a">Body</${tag}><${tag} id="b">Body<p slot="footer">Foot</p></${tag}>`, { modules: [tag] });
    const footers = () => page.evaluate((tag) => [...document.querySelectorAll(tag)].map((el) => !!(el.shadowRoot ?? el).querySelector('footer')), tag);
    const settle = () => page.evaluate((tag) => Promise.all([...document.querySelectorAll(tag)].map((el) => el.updateComplete)), tag);
    assert.deepEqual(await footers(), [false, true], tag);
    await page.evaluate((tag) => {
      const p = document.createElement('p');
      p.slot = 'footer';
      p.textContent = 'Late';
      document.querySelector(`${tag}#a`).append(p);
      document.querySelector(`${tag}#b [slot=footer]`).remove();
    }, tag);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    assert.deepEqual(await footers(), [true, false], tag);
    assert.deepEqual(messages, [], tag);
    await page.close();
  }
});

test('an empty URL leaves the attribute off, quietly; "[object Object]" from a framework is not given yet', async () => {
  // A prop's "" default before the app sets it (a link's href) isn't an unsafe URL to report.
  const { page, messages } = await open('<mnx-link href=""></mnx-link><mnx-header data="[object Object]"></mnx-header>', { modules: ['link', 'header'] });
  assert.equal(await page.$eval('mnx-link a', (a) => a.hasAttribute('href')), false);
  await page.evaluate(() => { document.querySelector('mnx-link').href = 'javascript:alert(1)'; });
  await page.evaluate(() => document.querySelector('mnx-link').updateComplete);
  assert.equal(await page.$eval('mnx-link a', (a) => a.hasAttribute('href')), false, 'an unsafe one is still refused');
  assert.equal(messages.filter((message) => message.includes('blocked an unsafe URL')).length, 1, 'and reported');
  // Svelte's server HTML writes an object prop as "[object Object]", then sets the object: the
  // element keeps its default meanwhile, without a warning.
  assert.deepEqual(await page.$$eval('mnx-header li', (items) => items.map((item) => item.textContent)), ['sample data', 'additional data']);
  assert.deepEqual(messages.filter((message) => !message.includes('blocked an unsafe URL')), []);
  await page.close();
});

test('hydrated(): false in the server HTML (rendered, not left for the browser), true once the element starts', async () => {
  const html = compiler(join(here, 'fixtures/live-filters.mnx'));
  assert.match(html, /<button class="apply">Apply<\/button>/);
  assert.match(html, /Press Apply/);
  assert.doesNotMatch(html, /\[\?/, 'nothing is left for the browser');
  const { page, messages } = await open(html, { modules: ['filters'] });
  await page.waitForFunction(() => document.querySelector('.hint').textContent === 'Filters apply as you type');
  assert.equal(await page.locator('.apply').count(), 0);
  assert.equal(await page.evaluate(() => document.querySelector('.hint').classList.contains('on')), true);
  assert.equal(await page.evaluate(() => document.querySelector('mnx-filters').matches(':state(hydrated)')), true);
  assert.deepEqual(messages, [], 'it hydrated the server markup, then changed');
  // Created in the browser, it's live from the start.
  assert.equal(await page.evaluate(async () => {
    const element = document.createElement('mnx-filters');
    document.body.append(element);
    await element.updateComplete;
    return [element.matches(':state(hydrated)'), element.querySelector('.hint').textContent].join();
  }), 'true,Filters apply as you type');
  await page.close();
});

test('server markup whose comments were stripped: a warning that says so, and a fresh render', async () => {
  const html = compiler(join(here, 'fixtures/live-filters.mnx')).replace(/<!--[^]*?-->/g, '');
  const { page, messages } = await open(html, { modules: ['filters'] });
  await page.waitForFunction(() => document.querySelector('.hint')?.textContent === 'Filters apply as you type');
  assert.equal(messages.length, 1, messages.join('\n'));
  assert.match(messages[0], /hydration markers .* are missing.*removed the comments/);
  await page.close();
});
