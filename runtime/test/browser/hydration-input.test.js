// What someone does to a server-rendered form before the element's module has loaded (ticks a
// box, types, picks an option) is still there after the element starts, and is what the form
// submits. Found by Outfitter: a day ticked while the page loaded was unticked by hydration, and
// the booking went off with no day. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { useBrowser, open, here, compiler, runtimeOnly } from './harness.js';

useBrowser({ early: join(here, 'fixtures/early-input.zb') });

test('input made before the element starts survives hydration, and later changes still apply', { skip: runtimeOnly }, async () => {
  const html = compiler(join(here, 'fixtures/early-input.zb'));
  assert.match(html, /<input type="checkbox" name="pool" value="a">/, 'server HTML, unticked');
  const { page, messages } = await open(html, {
    // A visitor, before the module arrives: ticks the first box, types, picks Large.
    beforeModules: `
      const form = document.getElementById('f');
      form.querySelector('[value=a]').click();
      form.note.value = 'typed early';
      form.size.value = 'l';
      form.said.value = 'said early';
    `,
    modules: ['early'],
  });
  await page.waitForFunction(() => window.ready);
  const after = await page.evaluate(async () => {
    const el = document.querySelector('zb-early');
    await el.updateComplete;
    const form = document.getElementById('f');
    return { data: [...new FormData(form)], b: form.querySelector('[value=b]').checked };
  });
  assert.deepEqual(after.data, [['pool', 'a'], ['note', 'typed early'], ['size', 'l'], ['said', 'said early']]);
  assert.equal(after.b, false, 'the box nobody touched still shows the state');
  // Once the state changes, it applies to every control, touched or not.
  const later = await page.evaluate(async () => {
    const el = document.querySelector('zb-early');
    el.ticked = true;
    el.note = 'from state';
    el.size = 's';
    await el.updateComplete;
    return [...new FormData(document.getElementById('f'))];
  });
  assert.deepEqual(later, [['pool', 'a'], ['pool', 'b'], ['note', 'from state'], ['size', 's'], ['said', 'from state']]);
  assert.deepEqual(messages, []);
  await page.close();
});

test('with nothing touched, the element sets its controls from state as before', { skip: runtimeOnly }, async () => {
  const props = join(mkdtempSync(join(tmpdir(), 'zubra-early-')), 'props.json');
  writeFileSync(props, JSON.stringify({ ticked: true, note: 'from the server', size: 's' }));
  const html = compiler(join(here, 'fixtures/early-input.zb'), '--props', props);
  const { page, messages } = await open(html, { modules: ['early'] });
  await page.waitForFunction(() => window.ready);
  const data = await page.evaluate(async () => {
    await document.querySelector('zb-early').updateComplete;
    return [...new FormData(document.getElementById('f'))];
  });
  assert.deepEqual(data, [['pool', 'a'], ['pool', 'b'], ['note', 'from the server'], ['size', 's'], ['said', 'from the server']]);
  assert.deepEqual(messages, []);
  await page.close();
});
