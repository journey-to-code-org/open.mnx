// Two components with one tag on a page: the first to load is defined, the other is ignored, and
// in development a warning says so (once). The compiler refuses this within what one component
// imports; this is the case it can't see, a page that loads both itself. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, production, emitElement } from './harness.js';

useBrowser({
  'twice-first': join(here, 'fixtures/twice-first.zb'),
  'twice-second': join(here, 'fixtures/twice-second.zb'),
  'twice-copy': join(here, 'fixtures/twice-copy.zb'),
});

test('a second, different definition of a tag is ignored, with one warning in development', async () => {
  const { page, messages } = await open('<zb-twice></zb-twice><zb-twice></zb-twice>', { modules: ['twice-first', 'twice-second'] });
  await page.waitForFunction(() => document.querySelectorAll('zb-twice p').length === 2);
  assert.deepEqual(await page.$$eval('zb-twice p', (ps) => ps.map((p) => p.className)), ['first', 'first']);
  const warnings = messages.filter((message) => message.includes('<zb-twice> is already defined, so another, different definition'));
  if (production || emitElement) {
    assert.deepEqual(warnings, [], 'production (and --emit element, which has no runtime) stays quiet');
  } else {
    assert.equal(warnings.length, 1, messages.join('\n'));
    assert.match(warnings[0], /whichever loads first wins/);
  }
  await page.close();
});

test('a second copy of the same component is ignored quietly', async () => {
  // An app's copy of a part a package also carries: they compile the same, comments aside.
  const { page, messages } = await open('<zb-twice></zb-twice>', { modules: ['twice-first', 'twice-copy'] });
  await page.waitForFunction(() => document.querySelector('zb-twice p'));
  assert.equal(await page.$eval('zb-twice p', (p) => p.className), 'first');
  assert.deepEqual(messages, []);
  await page.close();
});
