// The compiled-code interface version: modules compiled for another runtime are refused with a
// message that says what to do. Runs in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { define, $define, ABI } from '../src/index.js';

test('modules compiled for runtime 1.x, or another interface, are refused clearly', () => {
  assert.equal(ABI, 2);
  assert.throws(() => define('mnx-old', { props: {}, setup: () => [] }), /<mnx-old> was compiled for @mnx\/runtime 1\.x; recompile it with mnx 2/);
  assert.throws(() => $define('mnx-other', { abi: 3 }), /interface 3, this runtime is 2/);
  assert.throws(() => $define('mnx-none', {}), /interface 1, this runtime is 2/);
  // The current interface: without a DOM, a stand-in with the element's description.
  const Element = $define('mnx-now', { abi: ABI, props: { a: { attribute: 'a', default: 1 } } });
  assert.equal(Element.mnx.tag, 'mnx-now');
});
