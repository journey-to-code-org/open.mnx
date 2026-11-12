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

test('one change per field waits: a newer one replaces it, in order of the last write', () => {
  const saved = [];
  const outbox = outboxOf([], (pending) => saved.push(pending.length));
  const edit = (field, value, key = 't1') => ({ collection: 'tasks', key, field, value });
  for (let i = 0; i < 500; i++) outbox.add(edit('title', 'x'.repeat(i)));
  outbox.add(edit('done', true));
  outbox.add(edit('title', 'final'));
  outbox.add(edit('title', 'other doc', 't2'));
  outbox.add({ collection: 'notes', key: 't1', field: 'title', value: 'another collection' });
  assert.deepEqual(outbox.pending().map((c) => [c.key, c.field, c.value]), [['t1', 'done', true], ['t1', 'title', 'final'], ['t2', 'title', 'other doc'], ['t1', 'title', 'another collection']]);
  assert.equal(saved.at(-1), 4, 'and that is what was persisted');
});

test('a push already out with an older value: the newer one still goes next', () => {
  const outbox = outboxOf();
  const older = { collection: 'tasks', key: 't1', field: 'title', value: 'A' };
  const newer = { collection: 'tasks', key: 't1', field: 'title', value: 'AB' };
  outbox.add(older);
  const out = outbox.take();
  outbox.add(newer); // typed while the push was out
  outbox.done(out);
  assert.deepEqual(outbox.pending(), [newer]);
});

test('an outbox saved before this kept every change: it loads as one per field', () => {
  const field = (value) => ({ collection: 'tasks', key: 't1', field: 'title', value });
  const outbox = outboxOf([field('a'), field('ab'), { collection: 'tasks', key: 't1', field: 'done', value: true }, field('abc')]);
  assert.deepEqual(outbox.pending().map((c) => c.value), [true, 'abc']);
});
