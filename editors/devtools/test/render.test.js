// The pane's rendering, from readings shaped as runtime/src/devtools.js returns them. (The pane
// against a live page is tested in runtime/test/browser/devtools.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../render.js';

const reading = {
  version: 1,
  native: false,
  update: 3,
  component: { tag: 'dt-panel', file: '/app/src/dt-panel.zb', at: { line: 8, column: 1 }, located: true },
  props: [{ name: 'label', value: '"Panel"' }],
  state: [{ name: 'count', value: '1' }, { name: 'items', value: '[{text: "<b>", done: false}]' }],
  bindings: [
    { operation: 'textContent = …', target: '<p.double>', at: { line: 11, column: 21 }, dependsOn: ['doubled'], ranLast: true, here: true },
    { operation: "classList.toggle('done', …)", target: '<li>', at: { line: 14, column: 11 }, dependsOn: ['items[0].done'], ranLast: false, here: false },
  ],
  setBy: null,
  lastUpdate: { number: 3, written: ['count'], ran: 1 },
};

test('a component: its file and line, props, state, and the bindings on the node first', () => {
  const html = render(reading);
  assert.match(html, /<h1><code>&lt;dt-panel&gt;<\/code><\/h1>/);
  assert.match(html, /data-file="\/app\/src\/dt-panel.zb" data-line="8" data-column="1"[^>]*>dt-panel.zb:8</);
  assert.match(html, /<dt>label<\/dt><dd><code>&quot;Panel&quot;<\/code>/);
  const onNode = html.indexOf('On this node');
  const all = html.indexOf('All bindings (2)');
  assert.ok(onNode > 0 && all > onNode);
  assert.ok(html.indexOf('textContent = …') < all, 'the node\'s own binding is in its section');
  assert.match(html, /data-line="11" data-column="21"[^>]*>line 11</);
  assert.match(html, /reads <code>doubled<\/code>/);
  assert.match(html, /class="ran"/);
  assert.match(html, /update 3: wrote <code>count<\/code>, 1 of this component's bindings re-ran/);
  assert.match(html, /Signals: polyfill/);
});

test('page values are escaped', () => {
  const html = render(reading);
  assert.ok(!html.includes('<b>'), html);
  assert.match(html, /&lt;b&gt;/);
});

test('an unlocated component (an ordinary build) says how to get lines', () => {
  const html = render({
    ...reading,
    component: { tag: 'dt-plain', file: null, at: null, located: false },
    state: [],
    bindings: [{ operation: "addEventListener('click', …)", target: '<button>', at: null, dependsOn: [], ranLast: false, here: true }],
  });
  assert.match(html, /not located/);
  assert.match(html, /no line/);
  assert.match(html, /Names need a --devtools build/);
  assert.ok(!html.includes('data-file'), 'nothing to open');
});

test('what a parent binds onto a child component', () => {
  const html = render({
    ...reading,
    bindings: [],
    setBy: { tag: 'dt-panel', file: '/app/src/dt-panel.zb', bindings: [{ operation: '.value = …', target: '<dt-badge>', at: { line: 17, column: 13 }, dependsOn: ['count'], ranLast: false, here: true }] },
  });
  assert.match(html, /Set by <code>&lt;dt-panel&gt;<\/code>/);
  assert.match(html, /data-file="\/app\/src\/dt-panel.zb" data-line="17"/);
});

test('the other states: no runtime, connecting, outside a component, another version, an error', () => {
  assert.match(render({ missing: true }), /No Zubra development runtime/);
  assert.match(render(undefined), /No Zubra development runtime/);
  assert.match(render({ loading: true }), /Connecting/);
  assert.match(render({ version: 1, component: null }), /Not inside a Zubra component/);
  assert.match(render({ version: 2, component: null }), /speaks DevTools version 2/);
  assert.match(render({ error: 'x is not defined' }), /Couldn't read the page: x is not defined/);
});
