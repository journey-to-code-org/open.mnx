// Hydration markers in their three forms: processing instructions (`<?zb [?>`, what a 5.x server
// writes), the comments a browser without processing-instruction parsing makes of them
// (`<!--?zb [?-->`), and the plain comments of a 4.x server (`<!--[-->`). `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site } from './harness.js';

useBrowser({
  list: join(here, 'fixtures/list.zb'),
  people: join(here, 'fixtures/people.zb'),
});

const markers = /<\?zb ([^>]*?)\?>/g;
const forms = {
  'processing instructions': (html) => html,
  'comments parsed from them (no processing-instruction support)': (html) => html.replace(markers, '<!--?zb $1?-->'),
  'plain comments (a 4.x server)': (html) => html.replace(markers, '<!--$1-->'),
};

function serverHtml() {
  const listProps = join(site, 'markers-list.props.json');
  writeFileSync(listProps, JSON.stringify({ items: ['s1', 's2'], heading: 'Server' }));
  const peopleProps = join(site, 'markers-people.props.json');
  writeFileSync(peopleProps, JSON.stringify({ tags: ['a', 'b'] }));
  return compiler(join(here, 'fixtures/list.zb'), '--props', listProps)
    + compiler(join(here, 'fixtures/people.zb'), '--props', peopleProps);
}

for (const [name, form] of Object.entries(forms)) {
  test(`hydrates in place from markers as ${name}`, async () => {
    const html = form(serverHtml());
    if (name.startsWith('plain')) assert.doesNotMatch(html, /<\?zb|\?zb /);
    const { page, messages } = await open(html, {
      beforeModules: `window.before = [...document.querySelectorAll('zb-list *, zb-people *')];
        window.text = [...document.querySelector('zb-people p').childNodes].filter((node) => node.nodeType === 3);`,
      modules: ['list', 'people'],
    });
    const result = await page.evaluate(async () => {
      const list = document.querySelector('zb-list');
      const people = document.querySelector('zb-people');
      await Promise.all([list.updateComplete, people.updateComplete]);
      const after = [...document.querySelectorAll('zb-list *, zb-people *')];
      const same = after.length === window.before.length && after.every((node, i) => node === window.before[i]);
      const textKept = window.text.every((node) => node.isConnected);
      list.items = ['s1!', 's2', 's3'];
      people.tags = ['a', 'b', 'c'];
      await Promise.all([list.updateComplete, people.updateComplete]);
      return {
        same,
        textKept,
        items: [...list.querySelectorAll('li')].map((li) => li.textContent),
        tags: people.querySelector('p').textContent,
      };
    });
    assert.equal(result.same, true, 'every server element is kept');
    assert.equal(result.textKept, true, 'anchored text is kept');
    assert.deepEqual(result.items, ['s1!', 's2', 's3']);
    assert.equal(result.tags, '#a #b #c ');
    assert.deepEqual(messages, []);
    await page.close();
  });
}

test('an HTML minifier that removes comments leaves the markers, so the markup still hydrates in place', async () => {
  const html = serverHtml().replace(/<!--[^]*?-->/g, '');
  assert.match(html, /<\?zb \[\?>/);
  const { page, messages } = await open(html, {
    beforeModules: `window.before = [...document.querySelectorAll('zb-list *')];`,
    modules: ['list', 'people'],
  });
  const same = await page.evaluate(async () => {
    const list = document.querySelector('zb-list');
    await list.updateComplete;
    const after = [...list.querySelectorAll('*')];
    return after.length === window.before.length && after.every((node, i) => node === window.before[i]);
  });
  assert.equal(same, true);
  assert.deepEqual(messages, []);
  await page.close();
});
