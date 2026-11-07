// Events: emit() fires DOM events the compiler declared; before… events are cancelable; inner
// events with a component event's name stop at the host; shadow components' events leave the
// shadow root; parents listen with on…={handler}. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser({
  rating: join(here, 'fixtures/rating.mnx'),
  survey: join(here, 'fixtures/survey.mnx'),
  ping: join(here, 'fixtures/ping.mnx'),
  'swatch-pick': join(here, 'fixtures/swatch-pick.mnx'),
  reply: join(here, 'fixtures/reply-box.mnx'),
});

// Record what reaches the document: name, detail, and how the event was made.
const LISTEN = `window.seen = [];
for (const name of ['beforevaluechange', 'valuechange', 'change', 'ping']) {
  document.addEventListener(name, (event) => window.seen.push({
    name, detail: event.detail ?? null, custom: event instanceof CustomEvent,
    bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed,
    target: event.target.localName,
  }));
}`;

const seen = (page) => page.evaluate(() => window.seen);

test('emit() dispatches a bubbling CustomEvent with its detail, from the host', async () => {
  const { page, messages } = await open('<mnx-rating></mnx-rating>', { beforeModules: LISTEN, modules: ['rating'] });
  await page.click('mnx-rating .two');
  const base = { custom: true, bubbles: true, composed: false, target: 'mnx-rating' };
  assert.deepEqual(await seen(page), [
    { ...base, name: 'beforevaluechange', detail: 2, cancelable: true },
    { ...base, name: 'valuechange', detail: 2, cancelable: false },
    { ...base, name: 'change', detail: null, cancelable: false },
  ]);
  assert.equal(await page.$eval('mnx-rating', (rating) => rating.value), 2, 'props() writes the prop');
  assert.equal(await page.$eval('mnx-rating output', (output) => output.textContent), '2');
  assert.deepEqual(messages, []);
  await page.close();
});

test('preventDefault() on a before… event stops the change', async () => {
  const { page } = await open('<mnx-rating value="1"></mnx-rating>', {
    beforeModules: `${LISTEN}\ndocument.addEventListener('beforevaluechange', (event) => event.preventDefault());`,
    modules: ['rating'],
  });
  await page.click('mnx-rating .two');
  assert.deepEqual((await seen(page)).map((event) => event.name), ['beforevaluechange']);
  assert.equal(await page.$eval('mnx-rating', (rating) => rating.value), 1);
  await page.close();
});

test("an inner element's event with the component's event name stops at the host", async () => {
  const { page } = await open('<mnx-rating></mnx-rating>', {
    beforeModules: `${LISTEN}\nwindow.inner = 0;`,
    modules: ['rating'],
  });
  // The component's own listener on the inner input still runs (target phase) — here, a test one.
  await page.evaluate(() => {
    document.querySelector('mnx-rating .note').addEventListener('change', () => window.inner++);
    // Listeners on the host itself count as outside too.
    document.querySelector('mnx-rating').addEventListener('change', () => window.inner += 100);
  });
  await page.fill('mnx-rating .note', 'hello');
  await page.click('mnx-rating output');   // blur: the native <input> fires change
  assert.equal(await page.evaluate(() => window.inner), 1, 'the native change happened');
  assert.deepEqual(await seen(page), [], "it didn't escape the component");
  await page.close();
});

test("a parent listens with on…={handler}; a child's event with the parent's event name stops at the parent", async () => {
  const { page, messages } = await open('<mnx-survey></mnx-survey>', { beforeModules: LISTEN, modules: ['survey'] });
  await page.click('mnx-rating .one');
  await page.evaluate(() => document.querySelector('mnx-survey').updateComplete);
  assert.equal(await page.$eval('mnx-survey p', (p) => p.textContent), '1');
  assert.deepEqual((await seen(page)).map((event) => [event.name, event.target, event.detail]), [
    ['beforevaluechange', 'mnx-rating', 1],
    ['valuechange', 'mnx-survey', { rating: 1 }],   // the rating's own stopped at the survey
    ['change', 'mnx-rating', null],
  ]);
  assert.deepEqual(messages, []);
  await page.close();
});

test("a shadow component's events are composed, so they leave its shadow root", async () => {
  const { page } = await open('<mnx-ping></mnx-ping>', { beforeModules: LISTEN, modules: ['ping'] });
  await page.evaluate(() => document.querySelector('mnx-ping').shadowRoot.querySelector('button').click());
  assert.deepEqual(await seen(page), [
    { name: 'ping', detail: { at: 1 }, custom: true, bubbles: true, cancelable: false, composed: true, target: 'mnx-ping' },
  ]);
  await page.close();
});

test('emit, props and host explain themselves outside a component', async () => {
  const { page } = await open('', {});
  const errors = await page.evaluate(async () => {
    const runtime = await import('@mnx/runtime');
    return ['emit', 'props', 'host'].map((name) => {
      try { runtime[name]('x'); return 'no error'; } catch (error) { return error.message; }
    });
  });
  assert.match(errors[0], /bound to each element by the compiler/);
  assert.match(errors[1], /props\(\) must be called while a component is setting up/);
  assert.match(errors[2], /host\(\) must be called while a component is setting up/);
  await page.close();
});

test('.submit submits the element\'s form with validation; .mod is Ctrl here (⌘ on Apple); submit() and keys("mod+…") for JSX; value:bind keeps a child in step', async () => {
  const { page, messages } = await open('<mnx-reply></mnx-reply>', { modules: ['swatch-pick', 'reply'] });
  await page.evaluate(() => {
    window.sent = [];
    document.addEventListener('send', (event) => window.sent.push(event.detail));
  });
  const output = () => page.textContent('output');
  // The textarea is required: .submit uses requestSubmit(), so an empty form doesn't send.
  await page.selectOption('select', 'old');
  assert.deepEqual(await page.evaluate(() => window.sent), []);
  await page.fill('textarea', 'Hello');
  await page.selectOption('select', 'new');
  assert.deepEqual(await page.evaluate(() => window.sent), ['#000']);
  // Linux: .mod is Ctrl, and Meta isn't it.
  await page.press('textarea', 'Meta+Enter');
  assert.equal(await output(), '0 #000');
  await page.press('textarea', 'Control+Enter');
  assert.equal(await output(), '1 #000', 'the handler ran');
  assert.equal(await page.evaluate(() => window.sent.length), 2, 'then the form was submitted');
  await page.press('textarea', 'Control+k');
  assert.equal(await output(), '101 #000', 'keys("mod+k")');
  await page.click('.jsx-style');
  assert.equal(await output(), '1101 #000', 'submit(fn) ran fn');
  assert.equal(await page.evaluate(() => window.sent.length), 3, 'and submitted');
  // value:bind: the child's change comes back to the parent's `let`.
  await page.click('mnx-swatch .red');
  assert.equal(await output(), '1101 #f00');
  assert.deepEqual(messages, []);
  await page.close();
});

test('.mod is ⌘ on Apple platforms (and Ctrl isn\'t)', async () => {
  const { page, messages } = await open('<mnx-reply></mnx-reply>', {
    modules: ['swatch-pick', 'reply'],
    beforeModules: "Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }); Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });",
  });
  await page.fill('textarea', 'Hello');
  await page.press('textarea', 'Control+Enter');
  assert.equal(await page.textContent('output'), '0 #000');
  await page.press('textarea', 'Meta+Enter');
  assert.equal(await page.textContent('output'), '1 #000');
  await page.press('textarea', 'Meta+k');
  assert.equal(await page.textContent('output'), '101 #000');
  assert.deepEqual(messages, []);
  await page.close();
});
