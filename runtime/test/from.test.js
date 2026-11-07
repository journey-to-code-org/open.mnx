import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Signal } from '../src/signal.js';
import { from } from '../src/index.js';

test('from(): follows its source until assigned, then starts over when the source changes', () => {
  const seconds = new Signal.State(10);
  const left = from(seconds);
  assert.equal(left.get(), 10);
  seconds.set(20);
  assert.equal(left.get(), 20, 'follows while not assigned');
  left.set(left.get() - 1);
  assert.equal(left.get(), 19);
  seconds.set(20);
  assert.equal(left.get(), 19, 'the same value is no change');
  seconds.set(30);
  assert.equal(left.get(), 30, 'a new value starts over');
  // A function source, and readers that follow the result.
  const n = new Signal.State(1);
  const doubled = from(() => n.get() * 2);
  const shown = new Signal.Computed(() => `#${doubled.get()}`);
  assert.equal(shown.get(), '#2');
  doubled.set(7);
  assert.equal(shown.get(), '#7');
  n.set(5);
  assert.equal(shown.get(), '#10');
  // A plain value never changes, so it's state that starts there.
  const plain = from(3);
  plain.set(4);
  assert.equal(plain.get(), 4);
});
