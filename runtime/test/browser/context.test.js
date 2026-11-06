// Context on the Web Components Community Group Context Protocol, and id().
// `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here } from './harness.js';

useBrowser(
  {
    'theme-provider': join(here, 'fixtures/theme-provider.mnx'),
    'theme-label': join(here, 'fixtures/theme-label.mnx'),
  },
  {
    // The context key both components import.
    'theme.js': `import { createContext } from '@mnx/runtime';\nexport const theme = createContext('light');\n`,
  },
);

const PAGE = `
  <mnx-theme-provider><mnx-theme-label id="inside"></mnx-theme-label></mnx-theme-provider>
  <mnx-theme-label id="outside"></mnx-theme-label>`;

const labels = (page) =>
  page.$$eval('mnx-theme-label', (els) => els.map((el) => `${el.id}=${el.querySelector('span').textContent}`));

test('a consumer reads the nearest provider and follows its changes', async () => {
  const { page, messages } = await open(PAGE, { modules: ['theme-provider', 'theme-label'] });
  assert.deepEqual(await labels(page), ['inside=dark', 'outside=light'], 'no provider: the context default');
  await page.click('mnx-theme-provider button');
  await page.evaluate(() => document.querySelector('mnx-theme-label').updateComplete);
  assert.deepEqual(await labels(page), ['inside=light', 'outside=light']);
  await page.click('mnx-theme-provider button');
  await page.evaluate(() => document.querySelector('mnx-theme-label').updateComplete);
  assert.deepEqual(await labels(page), ['inside=dark', 'outside=light']);
  assert.deepEqual(messages, []);
  await page.close();
});

test('a consumer defined before its provider picks it up when the provider arrives', async () => {
  const { page } = await open(PAGE, { modules: ['theme-label', 'theme-provider'] });
  await page.evaluate(() => document.querySelector('mnx-theme-label').updateComplete);
  assert.deepEqual(await labels(page), ['inside=dark', 'outside=light']);
  await page.click('mnx-theme-provider button');
  await page.evaluate(() => document.querySelector('mnx-theme-label').updateComplete);
  assert.deepEqual(await labels(page), ['inside=light', 'outside=light']);
  await page.close();
});

test('moving a consumer out of its provider stops updates; moving it back resumes them', async () => {
  const { page } = await open(PAGE, { modules: ['theme-provider', 'theme-label'] });
  const result = await page.evaluate(async () => {
    const inside = document.getElementById('inside');
    const provider = document.querySelector('mnx-theme-provider');
    const toggle = () => provider.querySelector('button').click();
    const read = () => inside.querySelector('span').textContent;
    document.body.append(inside);          // now outside any provider
    toggle();
    await inside.updateComplete;
    const away = read();
    provider.querySelector('div').append(inside);   // back under the provider
    await inside.updateComplete;
    const back = read();
    toggle();
    await inside.updateComplete;
    return { away, back, after: read() };
  });
  assert.equal(result.away, 'dark', 'a detached-and-moved consumer is not updated by its old provider');
  assert.equal(result.back, 'light', 'on return it asks again and gets the current value');
  assert.equal(result.after, 'dark', 'and follows changes again');
  await page.close();
});

test('interoperates with any Context Protocol provider and consumer', async () => {
  const { page, messages } = await open(`
    <section id="foreign"><mnx-theme-label id="foreign-consumer"></mnx-theme-label></section>
    <mnx-theme-provider id="ours"><div id="raw-consumer"></div></mnx-theme-provider>`, {
    beforeModules: `
      // A provider written against the bare protocol, as another library would.
      const { theme } = await import('/theme.js');
      const foreign = document.getElementById('foreign');
      const subscribers = [];
      foreign.addEventListener('context-request', (event) => {
        if (event.context !== theme) return;
        event.stopPropagation();
        event.callback('from another library', () => {});
        if (event.subscribe) subscribers.push(event.callback);
      });
      window.foreignSet = (value) => subscribers.forEach((callback) => callback(value, () => {}));`,
    modules: ['theme-provider', 'theme-label'],
  });
  const result = await page.evaluate(async () => {
    const { theme } = await import('/theme.js');
    const { ContextRequestEvent } = await import('@mnx/runtime');
    const consumer = document.getElementById('foreign-consumer');
    const before = consumer.querySelector('span').textContent;
    window.foreignSet('updated by it');
    await consumer.updateComplete;
    const after = consumer.querySelector('span').textContent;
    // A consumer written against the bare protocol, asking our provider.
    const values = [];
    let unsubscribe;
    document.getElementById('raw-consumer').dispatchEvent(new ContextRequestEvent(theme, null, (value, stop) => {
      values.push(value);
      unsubscribe = stop;
    }, true));
    document.querySelector('#ours button').click();
    await consumer.updateComplete;
    unsubscribe();
    document.querySelector('#ours button').click();
    await consumer.updateComplete;
    return { before, after, values };
  });
  assert.equal(result.before, 'from another library', 'an mnx consumer reads a foreign provider');
  assert.equal(result.after, 'updated by it');
  assert.deepEqual(result.values, ['dark', 'light'], 'a foreign consumer reads our provider until it unsubscribes');
  assert.deepEqual(messages, []);
  await page.close();
});

test('id() gives each element and call its own stable id', async () => {
  const { page } = await open('<mnx-theme-label id="a"></mnx-theme-label><mnx-theme-label></mnx-theme-label><mnx-theme-label></mnx-theme-label>', {
    modules: ['theme-label'],
  });
  const ids = await page.$$eval('mnx-theme-label span', (spans) => spans.map((span) => [span.id, span.dataset.other]));
  assert.deepEqual(ids[0], ['a-1', 'a-2'], "based on the host's own id when it has one");
  assert.equal(new Set(ids.flat()).size, 6, 'all different');
  assert.match(ids[1][0], /^mnx-theme-label-\d+-1$/);
  await page.close();
});

test('hooks called outside setup explain themselves', async () => {
  const { page } = await open('', { modules: [] });
  const message = await page.evaluate(async () => {
    const { inject, createContext } = await import('@mnx/runtime');
    try { inject(createContext(1)); } catch (error) { return error.message; }
  });
  assert.equal(message, 'mnx: inject() must be called while a component is setting up');
  await page.close();
});

test('the nearest provider answers, and outer providers never see the request', async () => {
  const { page } = await open(`
    <mnx-theme-provider id="outer">
      <mnx-theme-provider id="inner"><mnx-theme-label id="deep"></mnx-theme-label></mnx-theme-provider>
      <mnx-theme-label id="mid"></mnx-theme-label>
    </mnx-theme-provider>`, { modules: ['theme-provider', 'theme-label'] });
  const read = () => page.evaluate(() => ({
    deep: document.getElementById('deep').querySelector('span').textContent,
    mid: document.getElementById('mid').querySelector('span').textContent,
  }));
  const toggle = (which) => page.evaluate(async (which) => {
    document.querySelector(`#${which} > div > button`).click();
    await document.getElementById('deep').updateComplete;
  }, which);
  assert.deepEqual(await read(), { deep: 'dark', mid: 'dark' });
  await toggle('outer');
  assert.deepEqual(await read(), { deep: 'dark', mid: 'light' }, "the outer provider doesn't reach past the inner one");
  await toggle('inner');
  assert.deepEqual(await read(), { deep: 'light', mid: 'light' });
  await page.close();
});

test('a consumer that was not answered asks again when a provider announces itself', async () => {
  const { page } = await open('<section id="late"><mnx-theme-label id="waiting"></mnx-theme-label></section>', {
    modules: ['theme-label'],
  });
  const result = await page.evaluate(async () => {
    const { theme } = await import('/theme.js');
    const { ContextProviderEvent } = await import('@mnx/runtime');
    const label = document.getElementById('waiting');
    const before = label.querySelector('span').textContent;
    const section = document.getElementById('late');
    section.addEventListener('context-request', (event) => {
      if (event.context !== theme) return;
      event.stopPropagation();
      event.callback('arrived late', () => {});
    });
    section.dispatchEvent(new ContextProviderEvent(theme, section));   // the consumer didn't move
    await label.updateComplete;
    return { before, after: label.querySelector('span').textContent };
  });
  assert.deepEqual(result, { before: 'light', after: 'arrived late' });
  await page.close();
});

test('a disconnected consumer unsubscribes from its provider', async () => {
  const { page } = await open('<section id="counting"><mnx-theme-label id="subscriber"></mnx-theme-label></section>', {
    beforeModules: `
      const { theme } = await import('/theme.js');
      window.subscribers = new Set();
      document.getElementById('counting').addEventListener('context-request', (event) => {
        if (event.context !== theme) return;
        event.stopPropagation();
        const entry = event.callback;
        window.subscribers.add(entry);
        event.callback('counted', () => window.subscribers.delete(entry));
      });`,
    modules: ['theme-label'],
  });
  const counts = await page.evaluate(() => {
    const before = window.subscribers.size;
    document.getElementById('subscriber').remove();
    return { before, after: window.subscribers.size };
  });
  assert.deepEqual(counts, { before: 1, after: 0 });
  await page.close();
});
