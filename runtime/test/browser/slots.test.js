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
    header: '<h2 slot="title">Mine</h2>',
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
