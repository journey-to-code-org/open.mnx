// The React and Vue adapters, in real apps: React 19, React 18 and Vue 3, bundled with esbuild.
// Props as properties, events, two-way binding by naming, and framework-managed children in
// light-DOM slots (keyed reorders, conditional content, removal). `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site } from './harness.js';

useBrowser({
  rating: join(here, 'fixtures/rating.zb'),
  card: join(here, 'fixtures/card.zb'),
  badge: join(here, 'fixtures/badge.zb'),
  seeded: join(here, 'fixtures/seeded.zb'),
});

const src = join(here, '../../src');

const REACT_APP = `
import { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { wrap } from '${src}/react.js';
import RatingElement from '/rating.js';
import CardElement from '/card.js';
import BadgeElement from '/badge.js';
import SeededElement from '/seeded.js';

const Rating = wrap(RatingElement), Card = wrap(CardElement), Badge = wrap(BadgeElement), Seeded = wrap(SeededElement);
window.log = [];

function App() {
  const [stars, setStars] = useState(1);
  const [items, setItems] = useState(['a']);
  const [title, setTitle] = useState(true);
  const [heading, setHeading] = useState('Hi');
  const [info, setInfo] = useState({ color: 'red' });
  const [cancel, setCancel] = useState(false);
  const [labelled, setLabelled] = useState(true);
  window.set = { setStars, setItems, setTitle, setHeading, setInfo, setCancel, setLabelled };
  const cardRef = useRef(null);
  window.cardRef = cardRef;
  return (
    <>
      <Rating id="r" className="big" value={stars}
        onValueChange={(event) => { window.log.push(['valuechange', event.detail]); setStars(event.detail); }}
        onBeforeValueChange={(event) => { if (cancel) event.preventDefault(); }}
        onChange={() => window.log.push(['change'])}
        onClick={() => window.log.push(['click'])}
        ref={(node) => { window.ratingRef = node; }} />
      <p id="stars">{stars}</p>
      <Card heading={heading} ref={cardRef}>
        {title && <h2 slot="title">Custom</h2>}
        {items.map((item) => <p key={item}>{item}</p>)}
      </Card>
      <Badge {...(labelled ? { label: 'x' } : {})} info={info} />
      <Seeded start={5} />
    </>
  );
}

const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<App />));
window.update = (fn) => flushSync(() => fn(window.set));
window.unmount = () => root.unmount();
`;

const VUE_APP = `
import { createApp, h, ref, nextTick, createCommentVNode } from 'vue';
import { wrap, models } from '${src}/vue.js';
import RatingElement from '/rating.js';
import CardElement from '/card.js';
import BadgeElement from '/badge.js';

const Rating = wrap(RatingElement), Card = wrap(CardElement), Badge = wrap(BadgeElement);
window.log = [];
window.models = models(RatingElement.zubra);

const state = {
  stars: ref(1), items: ref(['a']), title: ref(true), heading: ref('Hi'), info: ref({ color: 'red' }),
  text: ref(null),
};
const App = {
  setup() {
    return () => [
      h(Rating, {
        id: 'r', class: 'big', modelValue: state.stars.value,
        'onUpdate:modelValue': (value) => { window.log.push(['update:modelValue', value]); state.stars.value = value; },
        'onUpdate:value': (value) => window.log.push(['update:value', value]),
        onValuechange: (event) => window.log.push(['valuechange', event.detail]),
        onChange: () => window.log.push(['change']),
        onClick: () => window.log.push(['click']),
      }),
      h('p', { id: 'stars' }, String(state.stars.value)),
      h(Card, { heading: state.heading.value }, {
        default: () => state.text.value ?? state.items.value.map((item) => h('p', { key: item }, item)),
        // What a v-if that's off leaves in a slot: a comment, which isn't content.
        title: () => (state.title.value ? [h('h2', 'Custom'), 'and text'] : [createCommentVNode('v-if')]),
      }),
      h(Badge, { label: 'x', info: state.info.value }),
    ];
  },
};
const app = createApp(App);
app.mount('#root');
window.update = async (fn) => { fn(state); await nextTick(); };
window.unmount = () => app.unmount();
`;

// The page serves the runtime and the compiled components itself; everything else is bundled.
const pageModules = {
  name: 'page-modules',
  setup(builder) {
    builder.onResolve({ filter: /^\/[a-z-]+\.js$/ }, (args) => ({ path: args.path, external: true }));
  },
};

async function bundle(name, source, alias = {}) {
  const entry = join(site, `${name}.entry.jsx`);
  writeFileSync(entry, source);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile: join(site, `${name}.js`),
    jsx: 'automatic', alias, plugins: [pageModules], logLevel: 'error',
    nodePaths: [join(here, '../../node_modules')],
    define: {
      'process.env.NODE_ENV': '"development"',
      __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
}

before(async () => {
  await bundle('react19', REACT_APP);
  await bundle('react18', REACT_APP, { react: 'react18', 'react-dom': 'react-dom18' });
  await bundle('vue3', VUE_APP);
});

// Until every element is live (its listeners bound), a click can land on a button that does nothing:
// WebKit under load did that. `:state(hydrated)` is the signal that they're ready.
const settle = async (page) => {
  await page.waitForFunction(() => {
    const elements = [...document.querySelectorAll('zb-rating, zb-card, zb-badge')];
    return elements.length > 0 && elements.every((el) => el.matches(':state(hydrated)'));
  });
  await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve));
    await Promise.all([...document.querySelectorAll('zb-rating, zb-card, zb-badge')].map((el) => el.updateComplete));
  });
};

const read = (page) => page.evaluate(() => {
  const strip = (html) => html.replace(/<!--.*?-->/g, '');
  const card = document.querySelector('zb-card');
  return {
    rating: document.querySelector('zb-rating output').textContent,
    stars: document.getElementById('stars').textContent,
    header: strip(card.querySelector('header').innerHTML),
    section: strip(card.querySelector('section').innerHTML),
    footer: card.querySelector('footer').textContent,
    color: document.querySelector('zb-badge .badge').dataset.color,
    label: document.querySelector('zb-badge b').textContent,
  };
});

for (const version of ['react19', 'react18']) {
  test(`${version}: props, events and children through the React adapter`, async () => {
    const { page, messages } = await open('<div id="root"></div>', { modules: [version] });
    await settle(page);
    assert.deepEqual(await read(page), {
      rating: '1', stars: '1', header: '<h2 slot="title">Custom</h2>', section: '<p>a</p>', footer: 'Hi footer', color: 'red', label: 'x',
    });
    assert.deepEqual(await page.$eval('zb-rating', (el) => [el.id, el.className, el === window.ratingRef]), ['r', 'big', true],
      'other props and the ref reach the element');
    assert.equal(await page.evaluate(() => window.cardRef.current === document.querySelector('zb-card')), true, 'object refs too');
    // A script that seeds state from a prop sees it: React 19 sets the props as it creates the
    // element, and in React 18 the element reads them from `zb-props` when it starts (2.8).
    assert.equal(await page.textContent('zb-seeded output'), '5');

    await page.click('zb-rating .two');
    await settle(page);
    // The button's click handler fires the events; the click reaches the host afterwards.
    assert.deepEqual(await page.evaluate(() => window.log), [['valuechange', 2], ['change'], ['click']]);
    assert.equal((await read(page)).stars, '2', 'onValueChange updated the app (the controlled pattern)');

    await page.evaluate(() => window.update((set) => set.setCancel(true)));
    await page.click('zb-rating .one');
    await settle(page);
    assert.equal((await read(page)).rating, '2', 'preventDefault() in onBeforeValueChange kept the value');

    // Keyed reorder, insertion in the middle, conditional children: React calls insertBefore
    // and removeChild on the host.
    await page.evaluate(() => window.update((set) => set.setItems(['c', 'a', 'b'])));
    await settle(page);
    assert.equal((await read(page)).section, '<p>c</p><p>a</p><p>b</p>');
    await page.evaluate(() => window.update((set) => { set.setItems(['b']); set.setTitle(false); set.setHeading('New'); }));
    await settle(page);
    assert.deepEqual(await read(page), {
      rating: '2', stars: '2', header: '<h2>New</h2>', section: '<p>b</p>', footer: 'New footer', color: 'red', label: 'x',
    }, 'an emptied slot shows its fallback, which follows the props');
    await page.evaluate(() => window.update((set) => {
      set.setItems([]); set.setTitle(true); set.setHeading(undefined); set.setInfo({ color: 'blue' }); set.setLabelled(false);
    }));
    await settle(page);
    assert.deepEqual(await read(page), {
      rating: '2', stars: '2', header: '<h2 slot="title">Custom</h2>', section: '<p>No content</p>', footer: 'Card footer', color: 'blue',
      label: 'new',
    }, 'undefined and removed props are the default again; objects arrive as values');

    await page.evaluate(() => window.unmount());
    assert.equal(await page.$('zb-card'), null);
    assert.deepEqual(messages.filter((message) => !message.includes('Download the React DevTools')), []);
    await page.close();
  });
}

test('vue3: props, events, v-model and slots through the Vue adapter', async () => {
  const { page, messages } = await open('<div id="root"></div>', { modules: ['vue3'] });
  await settle(page);
  assert.deepEqual(await page.evaluate(() => window.models), [{ prop: 'value', event: 'valuechange' }]);
  assert.deepEqual(await read(page), {
    rating: '1', stars: '1', header: '<h2 slot="title">Custom</h2><span slot="title">and text</span>', section: '<p>a</p>',
    footer: 'Hi footer', color: 'red', label: 'x',
  });
  assert.deepEqual(await page.$eval('zb-rating', (el) => [el.id, el.className]), ['r', 'big']);

  await page.click('zb-rating .two');
  await settle(page);
  assert.deepEqual(await page.evaluate(() => window.log), [
    ['valuechange', 2], ['update:value', 2], ['update:modelValue', 2], ['change'], ['click'],
  ]);
  assert.equal((await read(page)).stars, '2', 'v-model updated the app');

  await page.evaluate(() => window.update((state) => { state.items.value = ['c', 'a', 'b']; }));
  await settle(page);
  assert.equal((await read(page)).section, '<p>c</p><p>a</p><p>b</p>');
  await page.evaluate(() => window.update((state) => { state.items.value = ['b']; state.title.value = false; state.heading.value = 'New'; }));
  await settle(page);
  assert.equal(await page.$eval('zb-card', (card) => card.innerHTML.includes('v-if')), false);
  assert.deepEqual(await read(page), {
    rating: '2', stars: '2', header: '<h2>New</h2>', section: '<p>b</p>', footer: 'New footer', color: 'red', label: 'x',
  });
  // Vue removes the <p> through its real parent, then inserts the text through the host.
  await page.evaluate(() => window.update((state) => { state.text.value = 'just text'; }));
  await settle(page);
  assert.equal((await read(page)).section, 'just text');
  await page.evaluate(() => window.update((state) => { state.text.value = null; state.items.value = []; state.info.value = { color: 'blue' }; state.heading.value = undefined; }));
  await settle(page);
  assert.deepEqual(await read(page), {
    rating: '2', stars: '2', header: '<h2>Card</h2>', section: '<p>No content</p>', footer: 'Card footer', color: 'blue', label: 'x',
  });

  // null is a value the element gets as is (Vue's own DOM-prop path would make it 0 here).
  await page.evaluate(() => window.update((state) => { state.stars.value = null; }));
  await settle(page);
  assert.equal(await page.$eval('zb-rating', (el) => el.value), null);

  await page.evaluate(() => window.unmount());
  assert.equal(await page.$('zb-card'), null);
  assert.deepEqual(messages.filter((message) => !/You are running a development build of Vue|Vue Devtools/.test(message)), []);
  await page.close();
});
