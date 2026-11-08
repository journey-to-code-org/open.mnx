// zb-if and zb-each in compiled components: fresh rendering, updates, and hydration of
// server-rendered regions. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useBrowser, open, compiler, here, site } from './harness.js';

useBrowser({
  list: join(here, 'fixtures/list.zb'),
  people: join(here, 'fixtures/people.zb'),
});

const readList = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('zb-list');
    return {
      items: [...el.querySelectorAll('li')].map((li) => `${li.dataset.i}:${li.textContent}`),
      hidden: el.querySelector('p')?.textContent ?? null,
      footer: el.querySelector('footer').textContent,
    };
  });

async function set(page, selector, values) {
  await page.evaluate(async ({ selector, values }) => {
    const el = document.querySelector(selector);
    Object.assign(el, values);
    await el.updateComplete;
  }, { selector, values });
}

test('zb-each grows, shrinks and updates rows in place', async () => {
  const { page, messages } = await open('<zb-list></zb-list>', { modules: ['list'] });
  assert.deepEqual(await readList(page), { items: ['0:a', '1:b'], hidden: null, footer: '2 items' });

  await page.evaluate(() => { window.firstLi = document.querySelector('zb-list li'); });
  await set(page, 'zb-list', { items: ['x', 'y', 'z'] });
  assert.deepEqual(await readList(page), { items: ['0:x', '1:y', '2:z'], hidden: null, footer: '3 items' });
  assert.equal(await page.evaluate(() => document.querySelector('zb-list li') === window.firstLi), true, 'existing rows are updated, not replaced');

  await set(page, 'zb-list', { items: ['only'] });
  assert.deepEqual(await readList(page), { items: ['0:only'], hidden: null, footer: '1 items' });
  await set(page, 'zb-list', { items: [] });
  assert.deepEqual(await readList(page), { items: [], hidden: 'Nothing to show', footer: '0 items' });
  assert.deepEqual(messages, []);
  await page.close();
});

test('zb-if switches branches, and a list inside a hidden branch comes back current', async () => {
  const { page, messages } = await open('<zb-list></zb-list>', { modules: ['list'] });
  await set(page, 'zb-list', { show: false });
  assert.deepEqual(await readList(page), { items: [], hidden: 'Nothing to show', footer: '2 items' });
  await set(page, 'zb-list', { items: ['p', 'q', 'r'] });
  assert.deepEqual(await readList(page), { items: [], hidden: 'Nothing to show', footer: '3 items' });
  await set(page, 'zb-list', { show: true });
  assert.deepEqual(await readList(page), { items: ['0:p', '1:q', '2:r'], hidden: null, footer: '3 items' });
  assert.deepEqual(messages, []);
  await page.close();
});

test('zb-if does not re-render when its test re-runs but the branch is the same', async () => {
  const { page } = await open('<zb-list></zb-list>', { modules: ['list'] });
  const same = await page.evaluate(async () => {
    const el = document.querySelector('zb-list');
    const ul = el.querySelector('ul');
    el.show = true;                // equal write: nothing happens
    el.items = ['a', 'b', 'c'];    // the test re-runs (it reads items.length) but stays true
    await el.updateComplete;
    return el.querySelector('ul') === ul;
  });
  assert.equal(same, true);
  await page.close();
});

test('changing one item updates only that row', async () => {
  const { page, messages } = await open('<zb-people></zb-people>', { modules: ['people'] });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('zb-people');
    const [first, second] = el.querySelectorAll('li');
    const secondText = second.querySelector('b').firstChild;
    el.people = [{ name: 'Grace', role: 'compilers' }, el.people[1]];
    await el.updateComplete;
    const [firstAfter, secondAfter] = el.querySelectorAll('li');
    return {
      text: [...el.querySelectorAll('li')].map((li) => li.textContent),
      sameRows: firstAfter === first && secondAfter === second,
      untouched: secondAfter.querySelector('b').firstChild === secondText,
    };
  });
  assert.deepEqual(result.text, ['Grace works on compilers', 'Linus works on kernels']);
  assert.equal(result.sameRows, true);
  assert.equal(result.untouched, true, "the unchanged row's text node is the same one");
  assert.deepEqual(messages, []);
  await page.close();
});

test('text directly inside a row renders through anchors', async () => {
  const { page } = await open('<zb-people></zb-people>', { modules: ['people'] });
  assert.equal(await page.$eval('zb-people p', (p) => p.textContent), '#x #y ');
  await set(page, 'zb-people', { tags: ['one', 'two', 'three'] });
  assert.equal(await page.$eval('zb-people p', (p) => p.textContent), '#one #two #three ');
  await page.close();
});

test('hydrates server-rendered regions without replacing their nodes', async () => {
  const props = join(site, 'list.props.json');
  writeFileSync(props, JSON.stringify({ items: ['s1', 's2', 's3'], heading: 'Server' }));
  const html = compiler(join(here, 'fixtures/list.zb'), '--props', props);
  assert.match(html, /<!--\[--><!--\[-->/, 'the server marks regions and rows');
  const { page, messages } = await open(html, {
    beforeModules: `window.before = [...document.querySelectorAll('zb-list *')];`,
    modules: ['list'],
  });
  const result = await page.evaluate(async () => {
    const el = document.querySelector('zb-list');
    const after = [...el.querySelectorAll('*')];
    const same = after.length === window.before.length && after.every((node, i) => node === window.before[i]);
    const firstLi = el.querySelector('li');
    el.items = ['s1!', 's2', 's3', 's4'];
    await el.updateComplete;
    return { same, kept: el.querySelector('li') === firstLi, items: [...el.querySelectorAll('li')].map((li) => li.textContent) };
  });
  assert.equal(result.same, true, 'every server node is kept');
  assert.equal(result.kept, true, 'hydrated rows stay live and update in place');
  assert.deepEqual(result.items, ['s1!', 's2', 's3', 's4']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('hydrates a server-rendered else branch and anchored row text', async () => {
  const props = join(site, 'people.props.json');
  writeFileSync(props, JSON.stringify({ tags: ['a', 'b'] }));
  const peopleHtml = compiler(join(here, 'fixtures/people.zb'), '--props', props);
  const listProps = join(site, 'hidden.props.json');
  writeFileSync(listProps, JSON.stringify({ show: false }));
  const listHtml = compiler(join(here, 'fixtures/list.zb'), '--props', listProps);
  const { page, messages } = await open(peopleHtml + listHtml, {
    beforeModules: `window.p = document.querySelector('zb-people p'); window.pNodes = [...window.p.childNodes]; window.hidden = document.querySelector('zb-list p');`,
    modules: ['people', 'list'],
  });
  const result = await page.evaluate(async () => {
    const same = [...window.p.childNodes].every((node, i) => node === window.pNodes[i]);
    const keptElse = document.querySelector('zb-list p') === window.hidden;
    const people = document.querySelector('zb-people');
    people.tags = ['a', 'c'];
    await people.updateComplete;
    const list = document.querySelector('zb-list');
    list.show = true;
    await list.updateComplete;
    return { same, keptElse, tags: window.p.textContent, items: [...list.querySelectorAll('li')].map((li) => li.textContent) };
  });
  assert.equal(result.same, true);
  assert.equal(result.keptElse, true);
  assert.equal(result.tags, '#a #c ');
  assert.deepEqual(result.items, ['a', 'b']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a server list that does not match its items is re-rendered with a warning', async () => {
  const html = compiler(join(here, 'fixtures/list.zb'));   // two rows
  const { page, messages } = await open(html, {
    beforeModules: `document.querySelector('zb-list').items = ['only one'];`,
    modules: ['list'],
  });
  assert.deepEqual((await readList(page)).items, ['0:only one']);
  assert.ok(messages.some((message) => message.startsWith('warning:') && message.includes('does not match its items')));
  await page.close();
});
