// The compiled-code interface version: modules compiled for another runtime are refused with a
// message that says what to do. Runs in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { define, $define, ABI } from '../src/index.js';

test('modules compiled for runtime 1.x, or another interface, are refused clearly', () => {
  assert.equal(ABI, 2);
  assert.throws(() => define('zb-old', { props: {}, setup: () => [] }), /<zb-old> was compiled for @zubra\/runtime 1\.x; recompile it with zubra 2/);
  assert.throws(() => $define('zb-other', { abi: 3 }), /interface 3, this runtime is 2/);
  assert.throws(() => $define('zb-none', {}), /interface 1, this runtime is 2/);
  // The current interface: without a DOM, a stand-in with the element's description.
  const Element = $define('zb-now', { abi: ABI, props: { a: { attribute: 'a', default: 1 } } });
  assert.equal(Element.zubra.tag, 'zb-now');
});
