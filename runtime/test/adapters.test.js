// The React and Vue adapters outside the browser: what they accept, the two-way binding pairs
// they find, and React server rendering. The browser suite runs them in real apps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { wrap as wrapReact } from '../src/react.js';
import { wrap as wrapVue, models } from '../src/vue.js';

const meta = (props, events = []) => ({
  tag: 'mnx-picker',
  props: Object.fromEntries(Object.entries(props).map(([name, value]) => [name, { attribute: name, default: value, required: false }])),
  events, slots: [], shadow: false, form: false,
});
const element = (props, events) => ({ mnx: meta(props, events) });

test('wrap() needs a compiled mnx element', () => {
  for (const wrap of [wrapReact, wrapVue]) {
    assert.throws(() => wrap(class {}), /needs a compiled mnx element/);
    assert.throws(() => wrap(undefined), /needs a compiled mnx element/);
  }
});

test('two-way bindings are <prop> + <prop>change pairs', () => {
  assert.deepEqual(models(meta({ value: '', selectedIndex: 0, open: false }, ['valuechange', 'selectedindexchange', 'toggle'])), [
    { prop: 'value', event: 'valuechange' },
    { prop: 'selectedIndex', event: 'selectedindexchange' },
  ]);
  assert.deepEqual(models(meta({ value: '' }, ['change'])), []);
});

test('the React wrapper renders on the server: the element, its attributes and children', () => {
  const Picker = wrapReact(element({ value: 1, info: { a: 1 } }, ['valuechange']));
  assert.equal(Picker.displayName, 'MnxPicker');
  const html = renderToString(React.createElement(Picker, { value: 2, info: { a: 2 }, id: 'p', className: 'big', onValueChange() {} },
    React.createElement('b', { slot: 'icon' }, 'hi')));
  assert.equal(html, '<mnx-picker id="p" class="big"><b slot="icon">hi</b></mnx-picker>',
    'props and event handlers are not attributes; they are set in the browser');
});

test('the Vue wrapper declares the props, events and v-model it supports', () => {
  const Picker = wrapVue(element({ value: '', label: 'x' }, ['valuechange', 'open']));
  assert.equal(Picker.name, 'MnxPicker');
  assert.deepEqual(Object.keys(Picker.props), ['value', 'label', 'modelValue']);
  assert.deepEqual(Picker.emits, ['valuechange', 'open', 'update:value', 'update:modelValue']);
  const NoModel = wrapVue(element({ label: 'x' }, ['open']));
  assert.deepEqual(Object.keys(NoModel.props), ['label']);
  assert.deepEqual(NoModel.emits, ['open']);
  const OnlyPair = wrapVue(element({ size: 1 }, ['sizechange']));
  assert.ok(OnlyPair.emits.includes('update:modelValue'), 'v-model binds the only pair when there is one');
});
