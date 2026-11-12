// Signal bridges (src/bridge.js): a Zubra signal read from framework code, through the store
// contract Svelte, Solid, Angular and RxJS accept, and React's and Vue's own hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { from as rxFrom } from 'rxjs';
import { effectScope, watch, nextTick, isRef } from 'vue';
import { Signal } from '../src/signal.js';
import { state, computed, from } from '../src/element.js';
import { tick } from '../src/effect.js';
import { subscribe, toStore, read, writable } from '../src/bridge.js';
import { useSignal as useReactSignal } from '../src/react.js';
import { useSignal as useVueSignal } from '../src/vue.js';

test('subscribe() calls back now, then once per batch of changes, until unsubscribed', async () => {
  const count = state(1);
  const seen = [];
  const stop = subscribe(count, (value) => seen.push(value));
  assert.deepEqual(seen, [1], 'the current value, synchronously');
  count.set(2);
  count.set(3);
  await tick();
  assert.deepEqual(seen, [1, 3], 'two writes in one task are one call, with the latest value');
  stop();
  count.set(4);
  await tick();
  assert.deepEqual(seen, [1, 3], 'nothing after unsubscribing');
});

test('subscribe() takes computeds, from(), native-shaped signals and functions of signals', async () => {
  const a = state(2);
  const double = computed(() => a.get() * 2);
  const linked = from(a);
  const plain = new Signal.State('x');
  const seen = { double: [], linked: [], plain: [], fn: [] };
  subscribe(double, (v) => seen.double.push(v));
  subscribe(linked, (v) => seen.linked.push(v));
  subscribe(plain, (v) => seen.plain.push(v));
  subscribe(() => `${a.get()}${plain.get()}`, (v) => seen.fn.push(v));
  a.set(3);
  plain.set('y');
  await tick();
  assert.deepEqual(seen, { double: [4, 6], linked: [2, 3], plain: ['x', 'y'], fn: ['2x', '3y'] });
});

test('subscribe() refuses what isn\'t a signal', () => {
  for (const value of [1, 'x', { get() {} }, null, undefined]) {
    assert.throws(() => subscribe(value, () => {}), /needs a signal/);
    assert.throws(() => toStore(value), /needs a signal/);
  }
});

test('deep: a mutation inside the value notifies; without it, it doesn\'t', async () => {
  const items = state([{ done: false }]);
  const shallow = [], deep = [];
  subscribe(items, (v) => shallow.push(v.length), {});
  subscribe(items, (v) => deep.push(v.map((item) => item.done).join()), { deep: true });
  items.get().push({ done: true });
  await tick();
  items.get()[0].done = true;
  await tick();
  assert.deepEqual(shallow, [1], 'shallow: the signal itself never changed');
  assert.deepEqual(deep, ['false', 'false,true', 'true,true'], 'deep: a push and a nested write each notify');
  items.set([]);
  await tick();
  assert.deepEqual(shallow, [1, 0], 'replacing the value notifies either way');
});

test('a callback that writes a signal does not subscribe to it', async () => {
  const source = state(1);
  const other = state(0);
  let calls = 0;
  subscribe(source, (v) => { calls++; other.set(other.get() + v); });
  other.set(10);
  await tick();
  assert.equal(calls, 1, 'reading and writing `other` inside the callback is untracked');
});

test('toStore(): the Svelte store contract', async () => {
  const count = state(0);
  const store = toStore(count);
  const seen = [];
  const unsubscribe = store.subscribe((v) => seen.push(v));
  assert.equal(typeof unsubscribe, 'function', 'subscribe returns the unsubscribe function');
  store.set(5);
  await tick();
  store.update((n) => n + 1);
  await tick();
  assert.equal(count.get(), 6, 'set and update write the signal: a writable store');
  assert.deepEqual(seen, [0, 5, 6]);
  unsubscribe();
  assert.equal(store.get(), 6);
});

test('toStore(): read-only for a computed', () => {
  const store = toStore(computed(() => 1));
  assert.equal(store.set, undefined);
  assert.equal(store.update, undefined);
  assert.equal(writable(computed(() => 1)), false);
  assert.equal(writable(state(1)), true);
  assert.equal(writable(from(state(1))), true, 'from() is assignable');
});

test('toStore(): an RxJS-style Subscribable (Angular toSignal, Solid from) and an interop observable', async () => {
  const count = state(1);
  const store = toStore(count);
  const seen = [];
  const subscription = store.subscribe({ next: (v) => seen.push(v) });
  assert.equal(typeof subscription.unsubscribe, 'function', 'subscribe({ next }) returns an Unsubscribable');
  count.set(2);
  await tick();
  subscription.unsubscribe();
  count.set(3);
  await tick();
  assert.deepEqual(seen, [1, 2]);

  const viaRx = [];
  const rx = rxFrom(store).subscribe((v) => viaRx.push(v));
  count.set(4);
  await tick();
  rx.unsubscribe();
  count.set(5);
  await tick();
  assert.deepEqual(viaRx, [3, 4], 'RxJS from() accepts it');
});

test('read() follows the source', () => {
  const a = state(1);
  assert.equal(read(a), 1);
  assert.equal(read(() => a.get() + 1), 2);
});

test('React useSignal: the value on the server', () => {
  const name = state('Ada');
  const greeting = computed(() => `Hi ${name.get()}`);
  function Hello() {
    return React.createElement('p', null, useReactSignal(greeting), ' ', useReactSignal(name, { deep: true }));
  }
  assert.equal(renderToString(React.createElement(Hello)), '<p>Hi Ada<!-- --> <!-- -->Ada</p>');
});

test('Vue useSignal: a ref that follows the signal and writes it, stopped with its scope', async () => {
  const count = state(1);
  const scope = effectScope();
  const seen = [];
  let ref;
  scope.run(() => {
    ref = useVueSignal(count);
    watch(ref, (v) => seen.push(v));
  });
  assert.ok(isRef(ref));
  assert.equal(ref.value, 1);
  count.set(2);
  await tick();
  await nextTick();
  assert.deepEqual(seen, [2], 'a change in the signal triggers Vue');
  ref.value = 7;
  assert.equal(count.get(), 7, 'assigning .value writes the signal');
  await tick();
  await nextTick();
  scope.stop();
  count.set(8);
  await tick();
  await nextTick();
  assert.deepEqual(seen, [2, 7], 'nothing after the scope stops');

  const doubled = useVueSignal(computed(() => count.get() * 2));
  assert.throws(() => { doubled.value = 1; }, /read-only/);
  doubled.stop();
});

test('Vue useSignal deep: a mutation inside triggers', async () => {
  const items = state([]);
  const scope = effectScope();
  const lengths = [];
  scope.run(() => {
    const ref = useVueSignal(items, { deep: true });
    watch(() => ref.value.length, (v) => lengths.push(v));
  });
  items.get().push(1);
  await tick();
  await nextTick();
  assert.deepEqual(lengths, [1]);
  scope.stop();
});
