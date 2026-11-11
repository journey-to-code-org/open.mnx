// Testing helpers: mount a Zubra component the way each framework's consumers do, so a library
// author can run one test through plain HTML, React and Vue, in any browser test runner (Vitest
// browser mode, Web Test Runner, Playwright's own).
//
//   import { frameworks, mount } from '@zubra/runtime/testing';
//   import StarRating from './star-rating.zb';
//
//   for (const framework of await frameworks()) {
//     test(`${framework}: a click sets the value and fires valuechange`, async () => {
//       const view = await mount(StarRating, { framework, props: { value: 2 } });
//       view.element.querySelector('button:nth-of-type(4)').click();
//       expect(view.events('valuechange')).toEqual([4]);
//       await view.set({ value: 1 });                 // through the framework, as an app would
//       expect(view.element.value).toBe(1);
//       view.unmount();
//     });
//   }
//
// A `<prop>change` event updates the prop the framework passes, as an app binding it two-way
// would (`v-model`, React's controlled pattern). React and Vue are imported only when asked for, through the same adapters apps use
// (`@zubra/runtime/react`, `@zubra/runtime/vue`), so events reach the framework's own handlers,
// props are set the framework's way, and slots are the framework's children.

const ALL = ['html', 'react', 'vue'];

/** The frameworks that can be mounted here: plain HTML always, React and Vue when installed. */
export async function frameworks() {
  const found = ['html'];
  for (const name of ['react', 'vue']) {
    try {
      await load(name);
      found.push(name);
    } catch {
      // not installed: skipped
    }
  }
  return found;
}

const loaded = {};
function load(framework) {
  if (framework === 'react') {
    loaded.react ??= Promise.all([import('react'), import('react-dom'), import('react-dom/client'), import('./react.js')])
      .then(([React, ReactDOM, client, adapter]) => ({ React, flushSync: ReactDOM.flushSync, createRoot: client.createRoot, wrap: adapter.wrap }));
    return loaded.react;
  }
  if (framework === 'vue') {
    loaded.vue ??= Promise.all([import('vue'), import('./vue.js')]).then(([Vue, adapter]) => ({ Vue, wrap: adapter.wrap }));
    return loaded.vue;
  }
  return Promise.resolve(null);
}

// What the element is doing once a change has landed: its own render, and the framework's.
const settle = async (element) => {
  await new Promise((resolve) => setTimeout(resolve));
  await element?.updateComplete;
};

/**
 * Mount `Element` (a compiled component's default export) through `framework` (`html`, `react` or
 * `vue`), with `props` and `slots` (`{ default: 'text', title: 'Heading' }`: text for each slot).
 * Resolves once it has rendered, to:
 * - `element`: the component's host element;
 * - `events(name)`: the `detail` of each `name` event so far, as the framework's handler got it
 *   (`events()`: every event as `[name, detail]`);
 * - `set(props)`: change props through the framework (merged with the current ones), and settle;
 * - `unmount()`: remove it the framework's way.
 */
export async function mount(Element, { framework = 'html', props = {}, slots = {}, container } = {}) {
  const meta = Element?.zubra;
  if (!meta) throw new TypeError('zubra: mount() needs a compiled zubra element (the default export of a .zb module)');
  if (!ALL.includes(framework)) throw new TypeError(`zubra: mount() knows ${ALL.join(', ')}, not "${framework}"`);
  if (!customElements.get(meta.tag)) customElements.define(meta.tag, Element);
  const host = container ?? document.body.appendChild(document.createElement('div'));
  const log = [];
  // Like an app that binds the component two-way (`v-model`, React's controlled pattern): a
  // `<prop>change` event updates the prop the framework passes back, so its next render doesn't
  // put the old value back.
  const models = Object.fromEntries(Object.keys(meta.props).filter((name) => meta.events.includes(`${name.toLowerCase()}change`)).map((name) => [`${name.toLowerCase()}change`, name]));
  let model = () => {};
  const record = (name) => (event) => {
    log.push([name, event.detail]);
    if (models[name]) model(models[name], event.detail);
  };
  let current = { ...props };
  let view;

  if (framework === 'html') {
    const element = document.createElement(meta.tag);
    for (const [name, value] of Object.entries(current)) element[name] = value;
    for (const name of meta.events) element.addEventListener(name, record(name));
    for (const [name, text] of Object.entries(slots)) {
      if (name === 'default') element.append(text);
      else element.append(Object.assign(document.createElement('span'), { slot: name, textContent: text }));
    }
    host.append(element);
    view = {
      element,
      set: async (next) => { Object.assign(current, next); for (const [name, value] of Object.entries(next)) element[name] = value; },
      unmount: () => element.remove(),
    };
  } else if (framework === 'react') {
    const { React, flushSync, createRoot, wrap } = await load('react');
    const Component = wrap(Element);
    const handlers = Object.fromEntries(meta.events.map((name) => [`on${name}`, record(name)]));
    const children = Object.entries(slots).map(([name, text]) =>
      name === 'default' ? text : React.createElement('span', { key: name, slot: name }, text));
    let element = null;
    const ref = (node) => { if (node) element = node; };
    const root = createRoot(host);
    const render = () => flushSync(() => root.render(React.createElement(Component, { ...current, ...handlers, ref }, ...children)));
    model = (name, value) => { current[name] = value; queueMicrotask(render); };
    render();
    view = {
      get element() { return element; },
      set: async (next) => { Object.assign(current, next); render(); },
      unmount: () => root.unmount(),
    };
  } else {
    const { Vue, wrap } = await load('vue');
    const Component = wrap(Element);
    const state = Vue.reactive({ ...current });
    model = (name, value) => { current[name] = value; state[name] = value; };
    const handlers = Object.fromEntries(meta.events.map((name) => [`on${name[0].toUpperCase()}${name.slice(1)}`, record(name)]));
    const slotFunctions = Object.fromEntries(Object.entries(slots).map(([name, text]) => [name, () => (name === 'default' ? text : Vue.h('span', text))]));
    const component = Vue.ref(null);
    const app = Vue.createApp({ render: () => Vue.h(Component, { ...state, ...handlers, ref: component }, slotFunctions) });
    app.mount(host);
    view = {
      get element() { return component.value?.element ?? null; },
      set: async (next) => { Object.assign(current, next); Object.assign(state, next); await Vue.nextTick(); },
      unmount: () => app.unmount(),
    };
  }

  await settle(view.element);
  const element = () => view.element;
  return {
    framework,
    host,
    get element() { return element(); },
    events: (name) => (name === undefined ? log.slice() : log.filter(([event]) => event === name).map(([, detail]) => detail)),
    async set(next) {
      await view.set(next);
      await settle(element());
    },
    unmount() {
      view.unmount();
      if (!container) host.remove();
    },
  };
}
