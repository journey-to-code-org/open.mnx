// mnx-slot in compiled components: light-DOM projection (the default) and native <slot> in
// shadow components, fresh and hydrated. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site } from './harness.js';

useBrowser({
  card: join(here, 'fixtures/card.mnx'),
  panel: join(here, 'fixtures/panel.mnx'),
});

const readCard = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('mnx-card');
    return {
      header: el.querySelector('header').innerHTML.replace(/<!--.*?-->/g, ''),
      section: el.querySelector('section')?.innerHTML.replace(/<!--.*?-->/g, '') ?? null,
      footer: el.querySelector('footer').textContent,
    };
  });

test("the element's own children are moved into its slots", async () => {
  const { page, messages } = await open('<mnx-card><h2 slot="title">Mine</h2>\n  <p>Body <b>text</b></p></mnx-card>', {
    beforeModules: `window.mine = document.querySelector('mnx-card h2'); window.body = document.querySelector('mnx-card p');`,
    modules: ['card'],
  });
  assert.deepEqual(await readCard(page), {
    header: '<h2 slot="title">Mine</h2>\n  ', // whitespace goes with the content before it
    section: '<p>Body <b>text</b></p>',
    footer: 'Card footer',
  });
  const same = await page.evaluate(() =>
    document.querySelector('mnx-card header h2') === window.mine && document.querySelector('mnx-card section p') === window.body);
  assert.equal(same, true, 'the same nodes, moved — not copies');
  assert.deepEqual(messages, []);
  await page.close();
});

test('an empty slot shows its fallback, which stays live', async () => {
  const { page } = await open('<mnx-card></mnx-card>', { modules: ['card'] });
  assert.deepEqual(await readCard(page), { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.evaluate(async () => {
    const el = document.querySelector('mnx-card');
    el.heading = 'Renamed';
    await el.updateComplete;
  });
  assert.deepEqual(await readCard(page), { header: '<h2>Renamed</h2>', section: '<p>No content</p>', footer: 'Renamed footer' });
  await page.close();
});

test('slotted content inside an mnx-if comes back when the branch does', async () => {
  const { page } = await open('<mnx-card><p>Kept</p></mnx-card>', {
    beforeModules: `window.kept = document.querySelector('mnx-card p');`,
    modules: ['card'],
  });
  const toggle = (value) => page.evaluate(async (value) => {
    const el = document.querySelector('mnx-card');
    el.open = value;
    await el.updateComplete;
  }, value);
  await toggle(false);
  assert.equal((await readCard(page)).section, null);
  await toggle(true);
  assert.equal((await readCard(page)).section, '<p>Kept</p>');
  assert.equal(await page.evaluate(() => document.querySelector('mnx-card section p') === window.kept), true);
  await page.close();
});

test('content for a slot that does not exist is reported', async () => {
  const { page, messages } = await open('<mnx-card><p slot="nope">?</p></mnx-card>', { modules: ['card'] });
  assert.ok(messages.some((message) => message.startsWith('warning:') && message.includes('no slot named "nope"')));
  assert.equal((await readCard(page)).section, '<p>No content</p>');
  await page.close();
});

test('hydrates supplied slot content as-is and binds the fallback of empty slots', async () => {
  const slots = join(site, 'card.slots.json');
  writeFileSync(slots, JSON.stringify({ title: '<h2>Server title</h2>' }));
  const html = compiler(join(here, 'fixtures/card.mnx'), '--slots', slots);
  assert.match(html, /<!--\[!--><h2>Server title<\/h2><!--\]-->/);
  assert.match(html, /<!--\[--><p>No content<\/p><!--\]-->/);
  const { page, messages } = await open(html, {
    beforeModules: `window.before = [...document.querySelectorAll('mnx-card *')];`,
    modules: ['card'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('mnx-card');
    const same = [...el.querySelectorAll('*')].every((node, i) => node === window.before[i]);
    el.heading = 'Updated';
    el.open = false;
    await el.updateComplete;
    el.open = true;
    await el.updateComplete;
    return { same };
  });
  assert.equal(result.same, true);
  assert.deepEqual(await readCard(page), { header: '<h2>Server title</h2>', section: '<p>No content</p>', footer: 'Updated footer' },
    'supplied content is static; the fallback and the rest are live');
  assert.deepEqual(messages, []);
  await page.close();
});

test('shadow components use native slots', async () => {
  const { page, messages } = await open('<mnx-panel><h3 slot="title">Mine</h3>Body</mnx-panel><mnx-panel id="empty"></mnx-panel>', { modules: ['panel'] });
  const result = await page.evaluate(async () => {
    const [full, empty] = document.querySelectorAll('mnx-panel');
    const assigned = (el, selector) => el.shadowRoot.querySelector(selector).assignedNodes().map((node) => node.textContent);
    const before = { title: assigned(full, 'slot[name=title]'), body: assigned(full, 'slot:not([name])') };
    const fallback = empty.shadowRoot.querySelector('slot[name=title]').textContent;
    empty.heading = 'Shadow heading';
    await empty.updateComplete;
    return { before, fallback, after: empty.shadowRoot.querySelector('slot[name=title]').textContent };
  });
  assert.deepEqual(result.before, { title: ['Mine'], body: ['Body'] });
  assert.equal(result.fallback, 'Panel');
  assert.equal(result.after, 'Shadow heading');
  assert.deepEqual(messages, []);
  await page.close();
});

test('a server-rendered shadow component hydrates its declarative shadow root', async () => {
  const slots = join(site, 'panel.slots.json');
  writeFileSync(slots, JSON.stringify({ title: '<h3>Server</h3>' }));
  const html = compiler(join(here, 'fixtures/panel.mnx'), '--slots', slots);
  assert.match(html, /<template shadowrootmode="open">.*<slot name="title"><h3>Panel<\/h3><\/slot>.*<\/template><h3 slot="title">Server<\/h3>/s);
  const { page, messages } = await open(html, {
    beforeModules: `window.slotEl = document.querySelector('mnx-panel').shadowRoot.querySelector('slot[name=title]');`,
    modules: ['panel'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('mnx-panel');
    const slot = el.shadowRoot.querySelector('slot[name=title]');
    el.heading = 'Changed';
    await el.updateComplete;
    return { same: slot === window.slotEl, assigned: slot.assignedNodes().map((node) => node.textContent), fallback: slot.textContent };
  });
  assert.equal(result.same, true, 'the declarative shadow root is reused');
  assert.deepEqual(result.assigned, ['Server']);
  assert.equal(result.fallback, 'Changed');
  assert.deepEqual(messages, []);
  await page.close();
});

// ---- content changed after startup, the way frameworks change it ----------------------------

/** Run `fn(card)` in the page, wait for DOM observers and updates, then read the card. */
async function change(page, fn) {
  await page.evaluate(`(async () => { const card = document.querySelector('mnx-card'); (${fn})(card);
    await new Promise((resolve) => setTimeout(resolve)); await card.updateComplete; })()`);
  return readCard(page);
}

test("the host's child methods put content into its slots after startup", async () => {
  const { page, messages } = await open('<mnx-card></mnx-card>', { modules: ['card'] });
  assert.deepEqual(await readCard(page), { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });

  // React: appendChild / insertBefore(node, sibling) / removeChild on the host.
  let card = await change(page, (el) => {
    window.b = Object.assign(document.createElement('p'), { textContent: 'b' });
    el.appendChild(window.b);
    el.insertBefore(Object.assign(document.createElement('p'), { textContent: 'a' }), window.b);
    const title = Object.assign(document.createElement('h2'), { textContent: 'T' });
    title.slot = 'title';
    el.appendChild(title);
  });
  assert.deepEqual(card, { header: '<h2 slot="title">T</h2>', section: '<p>a</p><p>b</p>', footer: 'Card footer' });

  card = await change(page, (el) => { el.removeChild(window.b); el.removeChild(el.querySelector('[slot=title]')); });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: '<p>a</p>', footer: 'Card footer' }, 'an emptied slot shows its fallback again');

  card = await change(page, (el) => el.replaceChild(Object.assign(document.createElement('i'), { textContent: 'i' }), el.querySelector('section p')));
  assert.equal(card.section, '<i>i</i>');

  // Vue: textContent for text-only children; React: innerHTML for dangerouslySetInnerHTML.
  card = await change(page, (el) => { el.textContent = 'just text'; });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: 'just text', footer: 'Card footer' });
  card = await change(page, (el) => { el.innerHTML = '<b>bold</b><h2 slot="title">H</h2>'; });
  assert.deepEqual(card, { header: '<h2 slot="title">H</h2>', section: '<b>bold</b>', footer: 'Card footer' });
  card = await change(page, (el) => { el.textContent = ''; });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });

  card = await change(page, (el) => {
    const fragment = document.createDocumentFragment();
    fragment.append('x', document.createElement('hr'));
    el.append(fragment, 'y');
  });
  assert.equal(card.section, 'x<hr>y');
  card = await change(page, (el) => el.replaceChildren('only'));
  assert.equal(card.section, 'only');

  assert.equal(await page.evaluate(() => {
    try { document.querySelector('mnx-card').removeChild(document.createElement('p')); return 'no error'; } catch (error) { return error.name; }
  }), 'NotFoundError', 'removing something that was never there still throws');
  assert.deepEqual(messages, []);
  await page.close();
});

test('content removed through its real parent leaves its slot (Vue removes via parentNode)', async () => {
  const { page } = await open('<mnx-card><p id="mine">mine</p></mnx-card>', { modules: ['card'] });
  const card = await change(page, () => { const p = document.getElementById('mine'); p.parentNode.removeChild(p); });
  assert.equal(card.section, '<p>No content</p>');
  // Moved elsewhere by the page: no longer the card's, so it isn't pulled back later.
  await change(page, (el) => { window.away = document.createElement('p'); el.appendChild(window.away); });
  await change(page, () => document.body.append(window.away));
  const after = await change(page, (el) => el.appendChild(document.createElement('hr')));
  assert.equal(after.section, '<hr>');
  assert.equal(await page.evaluate(() => window.away.parentNode === document.body), true);
  await page.close();
});

test('content for a slot that is not rendered waits, and can still be removed', async () => {
  const { page, messages } = await open('<mnx-card open="false"></mnx-card>', { modules: ['card'] });
  let card = await change(page, (el) => {
    window.kept = Object.assign(document.createElement('p'), { textContent: 'kept' });
    window.gone = Object.assign(document.createElement('p'), { textContent: 'gone' });
    el.append(window.kept, window.gone);
  });
  assert.equal(card.section, null, 'the branch holding the slot is off');
  await change(page, () => window.gone.parentNode.removeChild(window.gone));
  card = await change(page, (el) => { el.open = true; });
  assert.equal(card.section, '<p>kept</p>');
  card = await change(page, (el) => { el.open = false; });
  card = await change(page, (el) => { el.open = true; });
  assert.equal(card.section, '<p>kept</p>', 'it comes back each time the branch does');
  assert.deepEqual(messages, []);
  await page.close();
});

test('content for a slot that does not exist is reported, not shown', async () => {
  const { page, messages } = await open('<mnx-card></mnx-card>', { modules: ['card'] });
  const card = await change(page, (el) => {
    const stray = document.createElement('p');
    stray.slot = 'nope';
    el.appendChild(stray);
  });
  assert.equal(card.section, '<p>No content</p>');
  assert.ok(messages.some((message) => message.includes('has no slot named "nope"')), messages.join('\n'));
  await page.close();
});

test("changing a slotted element's slot attribute moves it to that slot", async () => {
  const { page } = await open('<mnx-card><h2 slot="title" id="t">T</h2></mnx-card>', { modules: ['card'] });
  let card = await change(page, () => { document.getElementById('t').slot = ''; });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: '<h2 slot="" id="t">T</h2>', footer: 'Card footer' },
    'the slot it left shows its fallback again');
  card = await change(page, () => { document.getElementById('t').slot = 'title'; });
  assert.deepEqual(card, { header: '<h2 slot="title" id="t">T</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.close();
});

test('a showing fallback is kept, not re-rendered, when its slot stays empty', async () => {
  const { page } = await open('<mnx-card></mnx-card>', { modules: ['card'] });
  await page.evaluate(() => { window.fallback = document.querySelector('mnx-card section p'); });
  await change(page, (el) => { el.textContent = ''; });
  assert.equal(await page.evaluate(() => window.fallback === document.querySelector('mnx-card section p')), true);
  await page.close();
});

test('content present at startup for a slot that is not rendered can be removed while it waits', async () => {
  const { page, messages } = await open('<mnx-card open="false"><p id="early">early</p><p>stays</p></mnx-card>', {
    beforeModules: "window.early = document.getElementById('early');",
    modules: ['card'],
  });
  await change(page, () => window.early.parentNode.removeChild(window.early));
  const card = await change(page, (el) => { el.open = true; });
  assert.equal(card.section, '<p>stays</p>');
  assert.deepEqual(messages, []);
  await page.close();
});

test('content removed through its real parent stays out when the host gets new content at once', async () => {
  // Vue's update order: remove the old child via parentNode, then insert the new one via the host.
  const { page } = await open('<mnx-card><p id="old">old</p></mnx-card>', { modules: ['card'] });
  const card = await change(page, (el) => {
    const old = document.getElementById('old');
    old.parentNode.removeChild(old);
    el.insertBefore(document.createTextNode('new'), null);
  });
  assert.equal(card.section, 'new');
  await page.close();
});

test("framework markers stay with their content, so a framework can update a slot by its markers (Lit's parts)", async () => {
  // Lit renders `${cond ? html`<h2 slot="title">…` : nothing}` as: start comment, content, then
  // the whitespace after it as the end. It clears and refills between those, through their parent.
  const { page, messages } = await open('<mnx-card><!--start--><h2 slot="title">T</h2>\n<!--items--><p>1</p></mnx-card>', {
    beforeModules: "window.start = document.querySelector('mnx-card').firstChild; window.end = document.querySelector('mnx-card h2').nextSibling;",
    modules: ['card'],
  });
  let card = await readCard(page);
  assert.equal(card.header, '<h2 slot="title">T</h2>\n');
  card = await change(page, () => { while (window.start.nextSibling !== window.end) window.start.nextSibling.remove(); });
  assert.equal(card.header, '<h2>Card</h2>', 'emptied through its markers: the fallback shows');
  card = await change(page, () => {
    const h2 = Object.assign(document.createElement('h2'), { textContent: 'again', slot: 'title' });
    window.end.parentNode.insertBefore(h2, window.end);
  });
  assert.equal(card.header, '<h2 slot="title">again</h2>\n', 'refilled next to its markers, while they waited in the park');
  assert.equal(card.section, '<p>1</p>');
  assert.deepEqual(messages, []);
  await page.close();
});

test("content inserted next to another slot's marker moves to its own slot (Svelte's anchors)", async () => {
  const { page } = await open('<mnx-card><p>1</p><!--anchor--></mnx-card>', {
    beforeModules: "window.anchor = document.querySelector('mnx-card').lastChild;",
    modules: ['card'],
  });
  const card = await change(page, () => {
    const h2 = Object.assign(document.createElement('h2'), { textContent: 'T', slot: 'title' });
    window.anchor.parentNode.insertBefore(h2, window.anchor);
  });
  assert.equal(card.header, '<h2 slot="title">T</h2>');
  assert.equal(card.section, '<p>1</p>');
  await page.close();
});

test('markers and whitespace alone leave a slot empty', async () => {
  const { page } = await open('<mnx-card>\n  <!--marker-->\n</mnx-card>', { modules: ['card'] });
  assert.deepEqual(await readCard(page), { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.close();
});
