// HTML lowercases attribute names, so a camelCase prop written as-is in a page (`maxValue`)
// arrives as `maxvalue`, which isn't the prop's attribute (`max-value`). The element says so
// instead of ignoring it silently. `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { useBrowser, open, here, emitElement } from './harness.js';

useBrowser({ 'case-meter': join(here, 'fixtures/case-meter.zb') });

test('a camelCase prop written in the page warns once, naming the attribute to write', { skip: emitElement && '--emit element output stays as small as a hand-written element: the warning is the runtime\'s (and `zubra check` reports it in .zb templates)' }, async () => {
  const { page, messages } = await open(
    '<case-meter id="camel" maxValue="9"></case-meter><case-meter id="right" max-value="7"></case-meter><case-meter id="both" maxvalue="1" max-value="3"></case-meter>',
    { modules: ['case-meter'] },
  );
  await page.evaluate(() => Promise.all([...document.querySelectorAll('case-meter')].map((el) => el.updateComplete)));
  assert.equal(await page.$eval('#camel p', (el) => el.textContent), 'Stars: 5', 'the lowercased attribute is still ignored');
  assert.equal(await page.$eval('#right p', (el) => el.textContent), 'Stars: 7');
  const warnings = messages.filter((message) => message.includes('lowercases'));
  assert.equal(warnings.length, 1, `only the element without max-value warns: ${JSON.stringify(messages)}`);
  assert.match(warnings[0], /<case-meter> ignores the attribute "maxvalue".*prop maxValue is the attribute "max-value"/);
  // Moving the element doesn't warn again.
  await page.evaluate(() => document.body.append(document.getElementById('camel')));
  assert.equal(messages.filter((message) => message.includes('lowercases')).length, 1);
  await page.close();
});
