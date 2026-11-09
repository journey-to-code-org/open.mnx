import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outboxOf } from '../src/connect.js';

test('a push that was already out never takes a change added since', () => {
  const saved = [];
  const outbox = outboxOf([], (pending) => saved.push(pending.map((change) => change.field)));
  const title = { field: 'title' };
  const done = { field: 'done' };
  outbox.add(title);
  const first = outbox.take(); // the debounced flush
  const second = outbox.take(); // the poll loop's flush, before the first came back
  outbox.add(done); // written while both are out
  outbox.done(first);
  outbox.done(second);
  assert.deepEqual(outbox.pending(), [done], 'the checkbox change is still waiting to be pushed');
  assert.deepEqual(saved.at(-1), ['done'], 'and that is what was persisted');
});

test('a failed push leaves everything; a later one takes what it sent', () => {
  const outbox = outboxOf();
  const a = { field: 'a' };
  const b = { field: 'b' };
  outbox.add(a);
  outbox.take(); // offline: never done
  outbox.add(b);
  const retry = outbox.take();
  assert.deepEqual(retry, [a, b]);
  outbox.done(retry);
  assert.equal(outbox.size, 0);
});
