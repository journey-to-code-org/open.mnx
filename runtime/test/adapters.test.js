// The React and Vue adapters outside the browser: what they accept, the two-way binding pairs
// they find, and React server rendering. The browser suite runs them in real apps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { wrap as wrapReact } from '../src/react.js';
import { wrap as wrapVue, models } from '../src/vue.js';
import { registerRenderer } from '../src/server.js';

const meta = (props, events = []) => ({
  tag: 'zb-picker',
  props: Object.fromEntries(Object.entries(props).map(([name, value]) => [name, { attribute: name, default: value, required: false }])),
  events, slots: [], shadow: false, form: false,
});
const element = (props, events) => ({ zubra: meta(props, events) });

test('wrap() needs a compiled zubra element', () => {
  for (const wrap of [wrapReact, wrapVue]) {
    assert.throws(() => wrap(class {}), /needs a compiled zubra element/);
    assert.throws(() => wrap(undefined), /needs a compiled zubra element/);
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
  assert.equal(Picker.displayName, 'ZbPicker');
  const html = renderToString(React.createElement(Picker, { value: 2, info: { a: 2 }, id: 'p', className: 'big', onValueChange() {} },
    React.createElement('b', { slot: 'icon' }, 'hi')));
  assert.equal(html, '<zb-picker id="p" class="big" zb-props="{&quot;value&quot;:2,&quot;info&quot;:{&quot;a&quot;:2}}"><b slot="icon">hi</b></zb-picker>',
    'props are written once, as JSON in zb-props (for the element, and for @zubra/server\'s shadow roots); event handlers are set in the browser');
  // No props given: no zb-props.
  assert.equal(renderToString(React.createElement(Picker, { id: 'q' })), '<zb-picker id="q"></zb-picker>');
});

test('the React wrapper renders a shadow-DOM element\'s shadow root on the server, when it has no children', () => {
  const field = {
    zubra: {
      tag: 'zb-shadow-field',
      props: { value: { attribute: 'value', default: 0, required: false, model: true }, label: { attribute: 'label', default: '', required: false, model: false } },
      events: ['valuechange'], slots: [], shadow: true, form: true,
    },
  };
  registerRenderer('zb-shadow-field', (props) => `<zb-shadow-field><template shadowrootmode="open"><b>${props.label ?? ''}: ${props.value ?? 0}</b></template></zb-shadow-field>`);
  const Field = wrapReact(field);
  assert.equal(renderToString(React.createElement(Field, { value: 3, label: 'Seats', name: 'seats' })),
    '<zb-shadow-field name="seats" zb-props="{&quot;value&quot;:3,&quot;label&quot;:&quot;Seats&quot;}"><template shadowrootmode="open"><b>Seats: 3</b></template><input type="hidden" name="seats" value="3" data-zb-fallback></zb-shadow-field>',
    'the shadow root, and the value a form would submit (for before JavaScript)');
  // Children go to its slots instead, so no shadow root is written (React would hydrate around it).
  assert.equal(renderToString(React.createElement(Field, { value: 3 }, 'x')), '<zb-shadow-field zb-props="{&quot;value&quot;:3}">x</zb-shadow-field>');
  // Without a renderer (no server build), an empty host, as before.
  const Other = wrapReact({ zubra: { ...field.zb, tag: 'zb-unrendered' } });
  assert.equal(renderToString(React.createElement(Other, {})), '<zb-unrendered></zb-unrendered>');
});

test('the Vue wrapper declares the props, events and v-model it supports', () => {
  const Picker = wrapVue(element({ value: '', label: 'x' }, ['valuechange', 'open']));
  assert.equal(Picker.name, 'ZbPicker');
  assert.deepEqual(Object.keys(Picker.props), ['value', 'label', 'modelValue']);
  assert.deepEqual(Picker.emits, ['valuechange', 'open', 'update:value', 'update:modelValue']);
  const NoModel = wrapVue(element({ label: 'x' }, ['open']));
  assert.deepEqual(Object.keys(NoModel.props), ['label']);
  assert.deepEqual(NoModel.emits, ['open']);
  const OnlyPair = wrapVue(element({ size: 1 }, ['sizechange']));
  assert.ok(OnlyPair.emits.includes('update:modelValue'), 'v-model binds the only pair when there is one');
});

test('ZubraContext renders <zb-context> on the server, React and Vue alike', async () => {
  const { ZubraContext } = await import('../src/react.js');
  const key = Object.freeze({ defaultValue: 'light' });
  assert.equal(renderToString(React.createElement(ZubraContext, { context: key, value: 'dark' }, React.createElement('p', null, 'x'))),
    '<zb-context style="display:contents"><p>x</p></zb-context>', 'the key and value are set in the browser');
  const { createSSRApp, h } = await import('vue');
  const { renderToString: vueToString } = await import('vue/server-renderer');
  const { ZubraContext: VueContext } = await import('../src/vue.js');
  const html = await vueToString(createSSRApp({ render: () => h(VueContext, { context: key, value: 'dark' }, () => [h('p', 'x')]) }));
  assert.equal(html, '<zb-context style="display: contents"><p>x</p></zb-context>');
});
