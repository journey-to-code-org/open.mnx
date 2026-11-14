// zb-slot in compiled components: light-DOM projection (the default) and native <slot> in
// shadow components, fresh and hydrated. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site, runtimeOnly } from './harness.js';

useBrowser({
  card: join(here, 'fixtures/card.zb'),
  panel: join(here, 'fixtures/panel.zb'),
  either: join(here, 'fixtures/either-link.zb'),
});

const readCard = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('zb-card');
    return {
      header: el.querySelector('header').innerHTML.replace(/<!--.*?-->|<\?zb.*?>/g, ''),
      section: el.querySelector('section')?.innerHTML.replace(/<!--.*?-->|<\?zb.*?>/g, '') ?? null,
      footer: el.querySelector('footer').textContent,
    };
  });

test("the element's own children are moved into its slots", async () => {
  const { page, messages } = await open('<zb-card><h2 slot="title">Mine</h2>\n  <p>Body <b>text</b></p></zb-card>', {
    beforeModules: `window.mine = document.querySelector('zb-card h2'); window.body = document.querySelector('zb-card p');`,
    modules: ['card'],
  });
  assert.deepEqual(await readCard(page), {
    header: '<h2 slot="title">Mine</h2>\n  ', // whitespace goes with the content before it
    section: '<p>Body <b>text</b></p>',
    footer: 'Card footer',
  });
  const same = await page.evaluate(() =>
    document.querySelector('zb-card header h2') === window.mine && document.querySelector('zb-card section p') === window.body);
  assert.equal(same, true, 'the same nodes, moved — not copies');
  assert.deepEqual(messages, []);
  await page.close();
});

test('an empty slot shows its fallback, which stays live', async () => {
  const { page } = await open('<zb-card></zb-card>', { modules: ['card'] });
  assert.deepEqual(await readCard(page), { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.evaluate(async () => {
    const el = document.querySelector('zb-card');
    el.heading = 'Renamed';
    await el.updateComplete;
  });
  assert.deepEqual(await readCard(page), { header: '<h2>Renamed</h2>', section: '<p>No content</p>', footer: 'Renamed footer' });
  await page.close();
});

test('slotted content inside an zb-if comes back when the branch does', async () => {
  const { page } = await open('<zb-card><p>Kept</p></zb-card>', {
    beforeModules: `window.kept = document.querySelector('zb-card p');`,
    modules: ['card'],
  });
  const toggle = (value) => page.evaluate(async (value) => {
    const el = document.querySelector('zb-card');
    el.open = value;
    await el.updateComplete;
  }, value);
  await toggle(false);
  assert.equal((await readCard(page)).section, null);
  await toggle(true);
  assert.equal((await readCard(page)).section, '<p>Kept</p>');
  assert.equal(await page.evaluate(() => document.querySelector('zb-card section p') === window.kept), true);
  await page.close();
});

test('content for a slot that does not exist is reported', async () => {
  const { page, messages } = await open('<zb-card><p slot="nope">?</p></zb-card>', { modules: ['card'] });
  assert.ok(messages.some((message) => message.startsWith('warning:') && message.includes('no slot named "nope"')));
  assert.equal((await readCard(page)).section, '<p>No content</p>');
  await page.close();
});

test('hydrates supplied slot content as-is and binds the fallback of empty slots', { skip: runtimeOnly }, async () => {
  const slots = join(site, 'card.slots.json');
  writeFileSync(slots, JSON.stringify({ title: '<h2>Server title</h2>' }));
  const html = compiler(join(here, 'fixtures/card.zb'), '--slots', slots);
  assert.match(html, /<\?zb \[!\?><h2>Server title<\/h2><\?zb \]\?>/);
  assert.match(html, /<\?zb \[\?><p>No content<\/p><\?zb \]\?>/);
  const { page, messages } = await open(html, {
    beforeModules: `window.before = [...document.querySelectorAll('zb-card *')];`,
    modules: ['card'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('zb-card');
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
  const { page, messages } = await open('<zb-panel><h3 slot="title">Mine</h3>Body</zb-panel><zb-panel id="empty"></zb-panel>', { modules: ['panel'] });
  const result = await page.evaluate(async () => {
    const [full, empty] = document.querySelectorAll('zb-panel');
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
  const html = compiler(join(here, 'fixtures/panel.zb'), '--slots', slots);
  assert.match(html, /<template shadowrootmode="open">.*<slot name="title"><h3>Panel<\/h3><\/slot>.*<\/template><h3 slot="title">Server<\/h3>/s);
  const { page, messages } = await open(html, {
    beforeModules: `window.slotEl = document.querySelector('zb-panel').shadowRoot.querySelector('slot[name=title]');`,
    modules: ['panel'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('zb-panel');
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
  await page.evaluate(`(async () => { const card = document.querySelector('zb-card'); (${fn})(card);
    await new Promise((resolve) => setTimeout(resolve)); await card.updateComplete; })()`);
  return readCard(page);
}

test("the host's child methods put content into its slots after startup", async () => {
  const { page, messages } = await open('<zb-card></zb-card>', { modules: ['card'] });
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
    try { document.querySelector('zb-card').removeChild(document.createElement('p')); return 'no error'; } catch (error) { return error.name; }
  }), 'NotFoundError', 'removing something that was never there still throws');
  assert.deepEqual(messages, []);
  await page.close();
});

test('content removed through its real parent leaves its slot (Vue removes via parentNode)', async () => {
  const { page } = await open('<zb-card><p id="mine">mine</p></zb-card>', { modules: ['card'] });
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
  const { page, messages } = await open('<zb-card open="false"></zb-card>', { modules: ['card'] });
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
  const { page, messages } = await open('<zb-card></zb-card>', { modules: ['card'] });
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
  const { page } = await open('<zb-card><h2 slot="title" id="t">T</h2></zb-card>', { modules: ['card'] });
  let card = await change(page, () => { document.getElementById('t').slot = ''; });
  assert.deepEqual(card, { header: '<h2>Card</h2>', section: '<h2 slot="" id="t">T</h2>', footer: 'Card footer' },
    'the slot it left shows its fallback again');
  card = await change(page, () => { document.getElementById('t').slot = 'title'; });
  assert.deepEqual(card, { header: '<h2 slot="title" id="t">T</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.close();
});

test('a showing fallback is kept, not re-rendered, when its slot stays empty', async () => {
  const { page } = await open('<zb-card></zb-card>', { modules: ['card'] });
  await page.evaluate(() => { window.fallback = document.querySelector('zb-card section p'); });
  await change(page, (el) => { el.textContent = ''; });
  assert.equal(await page.evaluate(() => window.fallback === document.querySelector('zb-card section p')), true);
  await page.close();
});

test('content present at startup for a slot that is not rendered can be removed while it waits', async () => {
  const { page, messages } = await open('<zb-card open="false"><p id="early">early</p><p>stays</p></zb-card>', {
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
  const { page } = await open('<zb-card><p id="old">old</p></zb-card>', { modules: ['card'] });
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
  const { page, messages } = await open('<zb-card><!--start--><h2 slot="title">T</h2>\n<!--items--><p>1</p></zb-card>', {
    beforeModules: "window.start = document.querySelector('zb-card').firstChild; window.end = document.querySelector('zb-card h2').nextSibling;",
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
  const { page } = await open('<zb-card><p>1</p><!--anchor--></zb-card>', {
    beforeModules: "window.anchor = document.querySelector('zb-card').lastChild;",
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

test("elements for one slot inserted together next to another slot's marker all move there (Angular's @if)", async () => {
  // Moving the first out of the list being walked used to skip the one after it (#262).
  const { page, messages } = await open('<zb-card><p>1</p><!--anchor--></zb-card>', {
    beforeModules: "window.anchor = document.querySelector('zb-card').lastChild;",
    modules: ['card'],
  });
  const card = await change(page, () => {
    for (const text of ['A', 'B', 'C']) {
      const h2 = Object.assign(document.createElement('h2'), { textContent: text, slot: 'title' });
      window.anchor.parentNode.insertBefore(h2, window.anchor);
    }
  });
  assert.equal(card.header, '<h2 slot="title">A</h2><h2 slot="title">B</h2><h2 slot="title">C</h2>');
  assert.equal(card.section, '<p>1</p>');
  assert.deepEqual(messages, []);
  await page.close();
});

test('an empty text node is slotted once it has text, and leaves when emptied (Angular\'s {{ }})', async () => {
  // Angular creates the text node for {{ }} empty and writes it afterwards. Empty text is a
  // marker, so it waited in the park and nothing heard it being written (#261).
  const { page, messages } = await open('<zb-card id="alone"></zb-card><zb-card id="after"><h2 slot="title">T</h2></zb-card>', {
    beforeModules: `
      window.alone = document.createTextNode('');
      document.getElementById('alone').append(window.alone);
      window.after = document.createTextNode('');
      document.getElementById('after').append(window.after);`,
    modules: ['card'],
  });
  const read = () => page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve));
    const clean = (el) => el.innerHTML.replace(/<!--.*?-->|<\?zb.*?>/g, '');
    return ['alone', 'after'].map((id) => [clean(document.querySelector(`#${id} header`)), clean(document.querySelector(`#${id} section`))].join(' | '));
  });
  assert.deepEqual(await read(), ['<h2>Card</h2> | <p>No content</p>', '<h2 slot="title">T</h2> | <p>No content</p>']);
  await page.evaluate(() => { window.alone.data = 'Hello'; window.after.data = 'World'; });
  assert.deepEqual(await read(), ['<h2>Card</h2> | Hello', '<h2 slot="title">T</h2> | World'], 'text is the default slot\'s, even after a named slot\'s element');
  await page.evaluate(() => { window.alone.data = 'Again'; });
  assert.deepEqual((await read())[0], '<h2>Card</h2> | Again');
  await page.evaluate(() => { window.alone.data = ''; });
  assert.deepEqual((await read())[0], '<h2>Card</h2> | <p>No content</p>', 'emptied, the fallback is back');
  await page.evaluate(() => { window.alone.data = 'Back'; });
  assert.deepEqual((await read())[0], '<h2>Card</h2> | Back');
  // One added after startup, through the host (as Angular does once the element is defined).
  await page.evaluate(() => { window.late = document.createTextNode(''); document.getElementById('after').append(window.late); window.late.data = '!'; });
  assert.deepEqual((await read())[1], '<h2 slot="title">T</h2> | World!');
  assert.deepEqual(messages, []);
  await page.close();
});

test("a framework's empty-text anchors stay with the content they bracket, so it can reorder through their parent (Vue's fragments)", async () => {
  // Vue brackets a v-for (any fragment) with two empty text nodes, and moves rows through the
  // start anchor's real parent. After a named slot's content, the start anchor used to join that
  // slot (whitespace goes with what's before it), so the reorder threw.
  const { page, messages } = await open('<zb-card><h2 slot="title">T</h2></zb-card>', {
    beforeModules: `
      const card = document.querySelector('zb-card');
      window.start = document.createTextNode('');
      window.end = document.createTextNode('');
      window.rows = ['1', '2', '3'].map((text) => Object.assign(document.createElement('p'), { textContent: text }));
      card.append(window.start, ...window.rows, window.end);`,
    modules: ['card'],
  });
  let card = await readCard(page);
  assert.equal(card.header, '<h2 slot="title">T</h2>');
  assert.equal(card.section, '<p>1</p><p>2</p><p>3</p>');
  assert.equal(await page.evaluate(() => window.start.parentNode === window.rows[0].parentNode && window.end.parentNode === window.rows[0].parentNode), true, 'both anchors are with the rows');
  card = await change(page, () => {
    const [one, , three] = window.rows;
    window.start.parentNode.insertBefore(three, one); // as Vue moves a keyed row
  });
  assert.equal(card.section, '<p>3</p><p>1</p><p>2</p>', 'and the new order stands');
  assert.deepEqual(messages, []);
  await page.close();
});

test('markers and whitespace alone leave a slot empty', async () => {
  const { page } = await open('<zb-card>\n  <!--marker-->\n</zb-card>', { modules: ['card'] });
  assert.deepEqual(await readCard(page), { header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer' });
  await page.close();
});

test('text alone given to an element whose template starts with a condition is slotted, and follows the branch that shows', async () => {
  const { page, messages } = await open('<zb-either>Save <b>now</b></zb-either><zb-either href="/go">Go</zb-either><zb-either></zb-either><zb-either href="/x"><b>Bold</b></zb-either><zb-either>Plain</zb-either>', { modules: ['either'] });

  const read = () => page.evaluate(() => [...document.querySelectorAll('zb-either')].map((el) => {
    const inner = el.querySelector('.either');
    return `${inner.localName}:${inner.innerHTML.replace(/<!--.*?-->|<\\?zb.*?>/g, '')}`;
  }));
  // Content shaped like the template is checked for stripped server markup first (remark.js, a
  // dynamic import), so those elements render a moment later: updateComplete waits for that.
  await page.evaluate(() => Promise.all([...document.querySelectorAll('zb-either')].map((el) => el.updateComplete)));
  assert.deepEqual(await read(), ['button:Save <b>now</b>', 'a:Go', 'button:Fallback', 'a:<b>Bold</b>', 'button:Plain'], 'text alone is content too, not server markup');
  await page.evaluate(async () => {
    const [first, second] = document.querySelectorAll('zb-either');
    window.bold = first.querySelector('b');
    first.href = '/now';
    second.href = '';
    await first.updateComplete;
    await second.updateComplete;
  });
  assert.deepEqual(await read(), ['a:Save <b>now</b>', 'button:Go', 'button:Fallback', 'a:<b>Bold</b>', 'button:Plain']);
  assert.equal(await page.evaluate(() => document.querySelector('zb-either a b') === window.bold), true, 'the same nodes, moved');
  assert.deepEqual(messages, []);
  await page.close();
});

test('text given to a template that is only regions renders at once, without loading remark.js', async () => {
  // What React and Svelte do (text, then connect): the element's template starts with a condition,
  // but the markup holds none of the elements its blocks start with (a, button), so it is the
  // page's own content, not server markup that lost its comments: no check, no wait. whenDefined
  // resolves right after the upgrade, so a render that waits for an import isn't there yet.
  const { page, messages } = await open('<zb-either>Save</zb-either><zb-either href="/go"><b>Go</b></zb-either>', {
    modules: ['either'],
    beforeModules: `window.rendered = customElements.whenDefined('zb-either').then(() =>
      [...document.querySelectorAll('zb-either')].map((el) => el.querySelector('.either')?.textContent ?? null));`,
  });
  assert.deepEqual(await page.evaluate(() => window.rendered), ['Save', 'Go']);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('remark'))), false, 'remark.js was not loaded');
  assert.deepEqual(messages, []);
  await page.close();
});

test('updateComplete waits for a first render that is waiting on the check for stripped server markup', { skip: runtimeOnly }, async () => {
  // Server markup of the same component with its markers stripped does hold a root (the button):
  // remark.js, a dynamic import, puts them back before the element starts. Asked for as soon as the
  // element is defined, updateComplete has to wait for that.
  const html = compiler(join(here, 'fixtures/either-link.zb')).replace(/<!--[^]*?-->|<\?zb[^]*?>/g, '');
  assert.match(html, /<button class="either"/);
  const { page, messages } = await open(html, {
    modules: ['either'],
    beforeModules: `window.started = customElements.whenDefined('zb-either').then(async () => {
      const el = document.querySelector('zb-either');
      await el.updateComplete;
      return el.matches(':state(hydrated)');
    });`,
  });
  assert.equal(await page.evaluate(() => window.started), true);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('remark'))), true, 'it had to load remark.js');
  assert.deepEqual(messages, []);
  await page.close();
});
