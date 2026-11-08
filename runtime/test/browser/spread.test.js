// {...spread} in compiled components: an object's entries as attributes, properties and
// listeners, with the security model's rules. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({ spread: join(here, 'fixtures/spread.zb') });

const set = (page, values) => page.evaluate(async (values) => {
  const el = document.querySelector('spread-demo');
  // `"fn:…"` strings become functions (they can't cross into the page as functions).
  const revive = (value) => typeof value === 'string' && value.startsWith('fn:') ? new Function('event', value.slice(3))
    : value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, revive(inner)])) : value;
  for (const [name, value] of Object.entries(values)) el[name] = revive(value);
  await el.updateComplete;
}, values);
const link = (page) => page.$eval('spread-demo a', (a) => ({
  attributes: Object.fromEntries([...a.attributes].map((attribute) => [attribute.name, attribute.value])),
  classes: [...a.classList],
  style: a.getAttribute('style') ?? '',
}));

test('attributes, booleans, aria, class merging, style objects, and removal', async () => {
  const { page, messages } = await open('<spread-demo></spread-demo>', { modules: ['spread'] });
  await set(page, { attrs: { href: '/a', 'aria-expanded': false, hidden: true, 'data-state': 'open', class: 'extra two', style: { color: 'red', '--accent': 'blue' } } });
  assert.deepEqual(await link(page), {
    attributes: { class: 'base extra two', title: 'own', href: '/a', 'aria-expanded': 'false', hidden: '', 'data-state': 'open', style: 'color: red; --accent: blue;' },
    classes: ['base', 'extra', 'two'],
    style: 'color: red; --accent: blue;',
  });
  // The element's own class: toggle and the spread's classes live together.
  await page.click('spread-demo button');
  await page.evaluate(() => document.querySelector('spread-demo').updateComplete);
  assert.deepEqual((await link(page)).classes, ['base', 'extra', 'two', 'lit']);
  // Entries that go away are removed; changed ones change; the own `title` wins throughout.
  await set(page, { attrs: { href: '/b', 'aria-expanded': true, class: 'two', title: 'theirs', style: { color: 'green' } } });
  assert.deepEqual(await link(page), {
    attributes: { class: 'base two lit', title: 'own', href: '/b', 'aria-expanded': 'true', style: 'color: green;' },
    classes: ['base', 'two', 'lit'],
    style: 'color: green;',
  });
  await set(page, { attrs: {} });
  assert.deepEqual((await link(page)).attributes, { class: 'base lit', title: 'own' });
  assert.deepEqual(messages, []);
});

test('listeners follow the latest function and go when their key does; properties are properties', async () => {
  const { page, messages } = await open('<spread-demo></spread-demo>', { modules: ['spread'] });
  await page.evaluate(() => { window.hits = []; });
  await set(page, { attrs: { onClick: 'fn:event.preventDefault(); window.hits.push("a")' } });
  await page.click('spread-demo a');
  await set(page, { attrs: { onclick: 'fn:event.preventDefault(); window.hits.push("b")' } });
  await page.click('spread-demo a');
  await set(page, { attrs: {} });
  await page.evaluate(() => document.querySelector('spread-demo a').addEventListener('click', (event) => event.preventDefault()));
  await page.click('spread-demo a');
  assert.deepEqual(await page.evaluate(() => window.hits), ['a', 'b'], 'one listener at a time, removed with its key');

  await set(page, { field: { value: 'typed', placeholder: 'Name' } });
  assert.equal(await page.inputValue('spread-demo input'), 'typed');
  assert.equal(await page.getAttribute('spread-demo input', 'value'), null, 'value is the property, not the attribute');
  await set(page, { field: { type: 'checkbox', checked: true } });
  assert.equal(await page.$eval('spread-demo input', (input) => input.checked), true);
  assert.deepEqual(messages, []);
});

test('what an attribute could not do, a spread cannot: unsafe URLs, text handlers, markup, style text', async () => {
  const { page, messages } = await open('<spread-demo></spread-demo>', { modules: ['spread'] });
  await set(page, { attrs: { href: 'javascript:alert(1)', onclick: 'alert(1)', innerHTML: '<img src=x onerror=alert(1)>', style: 'color: red', children: 'x' } });
  const { attributes } = await link(page);
  assert.equal(attributes.href, undefined, 'no unsafe URL');
  assert.equal(attributes.onclick, undefined, 'no handler as text');
  assert.equal(attributes.style, undefined, 'no style text');
  assert.equal(await page.textContent('spread-demo a'), 'link', 'no markup');
  assert.equal(messages.filter((message) => message.startsWith('error: zubra:')).length, 5, messages.join('\n'));
});
