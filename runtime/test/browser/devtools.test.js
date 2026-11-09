// The DevTools hook (`globalThis.__ZUBRA_DEVTOOLS__`): what the browser extension reads. The
// components are compiled with `--devtools`, as @zubra/unplugin does in Vite's dev server, except
// dt-plain, which shows what an ordinary build still gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, production, compiler, emitElement } from './harness.js';

const skip = (production && 'the production build has no DevTools hook')
  || (emitElement && '--emit element output has no runtime to hook');
const fixture = (name) => join(here, 'fixtures/devtools', `${name}.zb`);

useBrowser({ 'dt-plain': fixture('dt-plain') }, production || emitElement ? {} : {
  'dt-panel.js': () => compiler(fixture('dt-panel'), '--emit', 'js', '--devtools'),
  'dt-badge.js': () => compiler(fixture('dt-badge'), '--emit', 'js', '--devtools'),
});

/** Open the fixture page and connect, as the extension does. */
async function connected(body = '<dt-panel></dt-panel>', modules = ['dt-panel']) {
  const opened = await open(body, { modules });
  await opened.page.evaluate(() => globalThis.__ZUBRA_DEVTOOLS__.connect());
  await opened.page.waitForFunction(() => globalThis.__ZUBRA_DEVTOOLS__.ready === true);
  const inspect = (selector) => opened.page.evaluate(async (selector) => {
    await document.querySelector('dt-panel, dt-plain').updateComplete;
    return globalThis.__ZUBRA_DEVTOOLS__.inspect(document.querySelector(selector));
  }, selector);
  return { ...opened, inspect };
}

const named = (list, name) => list.find((item) => item.name === name)?.value;
const onNode = (result) => result.bindings.filter((binding) => binding.here);

test('a node maps to its component, file and line, with its props and state by name', { skip }, async () => {
  const { page, messages, inspect } = await connected();
  const result = await inspect('dt-panel p');
  assert.equal(result.version, 1);
  assert.equal(result.component.tag, 'dt-panel');
  assert.ok(result.component.file.endsWith('fixtures/devtools/dt-panel.zb'), result.component.file);
  assert.deepEqual(result.component.at, { line: 8, column: 1 });
  assert.equal(named(result.props, 'label'), '"Panel"');
  assert.equal(named(result.state, 'count'), '0');
  assert.equal(named(result.state, 'doubled'), '0');
  assert.equal(named(result.state, 'items'), '[{text: "a", done: false}]');
  assert.deepEqual(onNode(result), [{
    operation: 'textContent = …', target: '<p.double>', at: { line: 11, column: 21 },
    dependsOn: ['doubled'], ranLast: false, here: true,
  }]);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a binding depends on the named signals behind it, through rows and properties', { skip }, async () => {
  const { page, inspect } = await connected();
  const li = onNode(await inspect('dt-panel li'));
  assert.deepEqual(li.map(({ operation, at, dependsOn }) => ({ operation, at, dependsOn })), [
    { operation: "classList.toggle('done', …)", at: { line: 14, column: 11 }, dependsOn: ['items[0].done'] },
    { operation: 'textContent = …', at: { line: 14, column: 34 }, dependsOn: ['items[0].text'] },
  ]);
  const button = onNode(await inspect('dt-panel button.inc'));
  assert.deepEqual(button.map(({ operation, dependsOn }) => ({ operation, dependsOn })), [
    { operation: "addEventListener('click', …)", dependsOn: [] },
    { operation: 'textContent = …', dependsOn: ['label', 'count'] },
  ]);
  await page.close();
});

test('the last update says what was written and which bindings re-ran', { skip }, async () => {
  const { page, inspect } = await connected();
  const before = await inspect('dt-panel p');
  await page.click('button.inc');
  const after = await inspect('dt-panel p');
  assert.equal(after.lastUpdate.number, before.lastUpdate.number + 1);
  assert.deepEqual(after.lastUpdate.written, ['count']);
  assert.equal(onNode(after)[0].ranLast, true, 'the <p> showed doubled, which changed');
  assert.equal(after.bindings.find((binding) => binding.target === '<li.done>' || binding.operation.startsWith('classList')).ranLast, false, 'the rows did not');
  assert.equal(named(after.state, 'doubled'), '2');

  await page.click('button.add');
  const added = await inspect('dt-panel ul');
  assert.ok(added.lastUpdate.written.length > 0 && added.lastUpdate.written.every((name) => name.startsWith('items')), added.lastUpdate.written.join());
  assert.equal(added.bindings.find((binding) => binding.operation.startsWith('zb-each')).ranLast, true);
  await page.close();
});

test('a child component shows what its parent binds onto it', { skip }, async () => {
  const { page, inspect } = await connected();
  await page.click('button.inc');
  const badge = await inspect('dt-badge');
  assert.equal(badge.component.tag, 'dt-badge');
  assert.equal(named(badge.props, 'value'), '1');
  assert.equal(badge.setBy.tag, 'dt-panel');
  assert.deepEqual(badge.setBy.bindings.map(({ operation, at, dependsOn }) => ({ operation, at, dependsOn })), [
    { operation: '.value = …', at: { line: 17, column: 13 }, dependsOn: ['count'] },
  ]);
  await page.close();
});

test('an ordinary build still shows the component, unlocated', { skip }, async () => {
  const { page, inspect } = await connected('<dt-plain></dt-plain>', ['dt-plain']);
  const result = await inspect('dt-plain button');
  assert.equal(result.component.tag, 'dt-plain');
  assert.equal(result.component.located, false);
  assert.deepEqual(result.state, []);
  assert.deepEqual(onNode(result).map(({ operation, at }) => ({ operation, at })), [
    { operation: "addEventListener('click', …)", at: null },
    { operation: 'textContent = …', at: null },
  ]);
  await page.close();
});

test('a node outside any component has none', { skip }, async () => {
  const { page } = await connected('<p id="outside">x</p><dt-panel></dt-panel>');
  const result = await page.evaluate(() => globalThis.__ZUBRA_DEVTOOLS__.inspect(document.getElementById('outside')));
  assert.equal(result.component, null);
  await page.close();
});

test('the production build installs no hook', { skip: !production && 'runs with ZUBRA_RUNTIME=production' }, async () => {
  const { page } = await open('<dt-plain></dt-plain>', { modules: ['dt-plain'] });
  assert.equal(await page.evaluate(() => typeof globalThis.__ZUBRA_DEVTOOLS__), 'undefined');
  await page.close();
});
