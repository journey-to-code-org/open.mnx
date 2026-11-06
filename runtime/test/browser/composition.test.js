// Components using components: props passed as values, slot content from the parent's scope,
// updates, keyed moves, hydration of nested server markup, and third-party custom elements.
// `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site } from './harness.js';

useBrowser({
  badge: join(here, 'fixtures/badge.mnx'),
  inbox: join(here, 'fixtures/inbox.mnx'),
});

// A third-party element (not mnx) with a property, defined before the parent.
const WIDGET = `customElements.define('x-widget', class extends HTMLElement {
  set config(value) { this._config = value; this.textContent = 'size ' + value.size; }
  get config() { return this._config; }
});`;

const readBadges = (page) =>
  page.$$eval('mnx-inbox mnx-badge', (badges) => badges.map((badge) => ({
    who: badge.dataset.who,
    cls: badge.className,
    label: badge.label,
    count: badge.count,
    color: badge.querySelector('.badge').dataset.color,
    text: badge.querySelector('.badge').textContent.replace(/\s+/g, ' ').trim(),
    iconFirst: badge.querySelector('.badge').firstElementChild?.localName,
  })));

async function setItems(page, items) {
  await page.evaluate(async (items) => {
    const inbox = document.querySelector('mnx-inbox');
    inbox.items = items;
    await inbox.updateComplete;
    await Promise.all([...inbox.querySelectorAll('mnx-badge')].map((badge) => badge.updateComplete));
  }, items);
}

test('a parent passes props as values and its content fills the child slots', async () => {
  const { page, messages } = await open('<mnx-inbox></mnx-inbox>', { beforeModules: WIDGET, modules: ['inbox'] });
  assert.deepEqual(await readBadges(page), [
    { who: 'Ada', cls: 'row', label: 'Ada', count: 3, color: 'red', text: '* Ada 3 unread', iconFirst: 'em' },
    { who: 'Linus', cls: 'row', label: 'Linus', count: 0, color: 'gray', text: '- Linus 0 read', iconFirst: 'em' },
  ]);
  assert.equal(await page.$eval('x-widget', (widget) => widget.textContent), 'size 2', 'objects reach another library\'s element as a property');
  assert.deepEqual(messages, []);
  await page.close();
});

test('parent changes flow into child props and slotted content; keyed children move', async () => {
  const { page, messages } = await open('<mnx-inbox></mnx-inbox>', { beforeModules: WIDGET, modules: ['inbox'] });
  await page.evaluate(() => { window.ada = document.querySelector('mnx-badge[data-who=Ada]'); });
  await setItems(page, [{ name: 'Linus', unread: 5 }, { name: 'Ada', unread: 0 }, { name: 'Grace', unread: 1 }]);
  assert.deepEqual((await readBadges(page)).map((badge) => [badge.who, badge.text, badge.color]), [
    ['Linus', '* Linus 5 unread', 'red'],
    ['Ada', '- Ada 0 read', 'gray'],
    ['Grace', '* Grace 1 unread', 'red'],
  ]);
  assert.equal(await page.evaluate(() => document.querySelector('mnx-badge[data-who=Ada]') === window.ada), true, 'the same child element, moved');
  assert.equal(await page.$eval('x-widget', (widget) => widget.textContent), 'size 3');
  assert.deepEqual(messages, []);
  await page.close();
});

test('hydrates a parent and its children from nested server markup', async () => {
  const html = compiler(join(here, 'fixtures/inbox.mnx'));
  assert.match(html, /<mnx-badge class="row" data-who="Ada" label="Ada" count="3" info="\{&quot;color&quot;:&quot;red&quot;\}">/, 'the child is rendered inline, with its props on the host');
  assert.match(html, /<!--\[!--><em slot="icon">\*<\/em><!--\]-->/, 'slotted content is where the child puts it');
  assert.match(html, /<x-widget config="\{&quot;size&quot;:2\}" mode="plain">/);
  const { page, messages } = await open(html, {
    beforeModules: WIDGET + `window.before = [...document.querySelectorAll('mnx-inbox *')].filter((node) => node.localName !== 'x-widget');`,
    modules: ['inbox'],
  });
  const same = await page.evaluate(() => {
    const after = [...document.querySelectorAll('mnx-inbox *')].filter((node) => node.localName !== 'x-widget');
    return after.length === window.before.length && after.every((node, i) => node === window.before[i]);
  });
  assert.equal(same, true, 'every server node — parent, children and slotted content — is kept');
  await setItems(page, [{ name: 'Ada', unread: 0 }, { name: 'Linus', unread: 2 }]);
  assert.deepEqual((await readBadges(page)).map((badge) => badge.text), ['- Ada 0 read', '* Linus 2 unread'],
    "the parent's bindings inside the children's slots are live after hydration");
  assert.deepEqual(messages, []);
  await page.close();
});

test("an element whose children aren't server markup isn't mistaken for it", async () => {
  // A badge used directly in a page, with content that happens to resemble its template.
  const { page, messages } = await open('<mnx-badge label="Hi"><span class="badge">mine</span></mnx-badge>', { modules: ['badge'] });
  assert.equal(await page.$eval('mnx-badge b', (b) => b.textContent), 'Hi');
  assert.equal(await page.$eval('mnx-badge .badge .badge', (inner) => inner.textContent), 'mine', 'it is slotted, not hydrated');
  assert.deepEqual(messages, []);
  await page.close();
});

test('an unknown custom element gets attributes until it has the property', async () => {
  const { page } = await open('<mnx-inbox></mnx-inbox>', { modules: ['inbox'] });   // x-widget never defined
  assert.equal(await page.$eval('x-widget', (widget) => widget.getAttribute('config')), '{"size":2}');
  await page.close();
});
