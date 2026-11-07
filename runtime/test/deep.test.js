// Deep reactivity: a state's array or plain object updates what read it when it's mutated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, computed, from, raw, Signal } from '../src/index.js';
import { effect, flush } from '../src/effect.js';

const watch = (fn) => {
  const seen = [];
  effect(() => seen.push(fn()));
  flush();
  return seen;
};

test('push, splice and index writes on a state array update a computed that reads it', () => {
  const items = state([1, 2]);
  const total = computed(() => items.get().reduce((a, b) => a + b, 0));
  const seen = watch(() => total.get());
  items.get().push(3);
  flush();
  items.get().splice(0, 1);
  flush();
  items.get()[0] = 10;
  flush();
  assert.deepEqual(seen, [3, 6, 5, 13]);
});

test('a nested object property is tracked on its own', () => {
  const items = state([{ id: 1, done: false }, { id: 2, done: false }]);
  let firstRuns = 0;
  let secondRuns = 0;
  effect(() => { items.get()[0].done; firstRuns++; });
  effect(() => { items.get()[1].done; secondRuns++; });
  flush();
  items.get()[0].done = true;
  flush();
  assert.equal(firstRuns, 2);
  assert.equal(secondRuns, 1);
});

test('reassigning a state wraps the new value too', () => {
  const items = state([]);
  const seen = watch(() => items.get().length);
  items.set([1]);
  flush();
  items.get().push(2);
  flush();
  assert.deepEqual(seen, [0, 1, 2]);
});

test('a plain object state tracks added, changed and deleted keys', () => {
  const form = state({ name: '' });
  const seen = watch(() => Object.keys(form.get()).join(',') + ':' + form.get().name);
  form.get().name = 'a';
  flush();
  form.get().email = 'b';
  flush();
  delete form.get().email;
  flush();
  assert.deepEqual(seen, ['name:', 'name:a', 'name,email:a', 'name:a']);
});

test('setting a property to the same value does not notify', () => {
  const box = state({ n: 1 });
  const seen = watch(() => box.get().n);
  box.get().n = 1;
  flush();
  assert.deepEqual(seen, [1]);
});

test('class instances, Maps, dates, functions and primitives are not wrapped', () => {
  class Point { constructor() { this.x = 1; } }
  const point = new Point();
  const map = new Map();
  const date = new Date();
  const fn = () => 1;
  for (const value of [point, map, date, fn, 1, 'a', null, undefined]) {
    assert.equal(state(value).get(), value);
  }
});

test('raw() gives the original object back, and the proxy is the same each time', () => {
  const original = [1];
  const items = state(original);
  assert.notEqual(items.get(), original);
  assert.equal(raw(items.get()), original);
  assert.equal(items.get(), items.get());
  assert.equal(state(original).get(), items.get());
  assert.equal(raw(5), 5);
});

test('the proxy behaves as the array: isArray, JSON, spread, length, in', () => {
  const items = state([{ a: 1 }]);
  const proxy = items.get();
  assert.ok(Array.isArray(proxy));
  assert.equal(JSON.stringify(proxy), '[{"a":1}]');
  assert.deepEqual([...proxy], [{ a: 1 }]);
  assert.equal(proxy.length, 1);
  assert.ok(0 in proxy);
  assert.deepEqual(raw(proxy[0]), { a: 1 });
});

test('a value assigned into the structure is stored raw, not as a proxy', () => {
  const list = state([]);
  const inner = state({ a: 1 });
  list.get().push(inner.get());
  assert.equal(raw(list.get())[0][Symbol.for('nothing')], undefined);
  assert.equal(raw(list.get())[0], raw(inner.get()));
});

test('from() wraps the value it follows and the value assigned', () => {
  const source = new Signal.State([1]);
  const linked = from(() => source.get());
  const seen = watch(() => linked.get().length);
  linked.get().push(2);
  flush();
  linked.set([0, 0, 0]);
  flush();
  linked.get().push(0);
  flush();
  source.set([5]);
  flush();
  assert.deepEqual(seen, [1, 2, 3, 4, 1]);
});

test('an array read through a state mutated from inside a handler-like closure updates once per flush', () => {
  const items = state([]);
  let runs = 0;
  effect(() => { items.get().length; runs++; });
  flush();
  items.get().push(1);
  items.get().push(2);
  items.get().push(3);
  flush();
  assert.equal(runs, 2);
});
