// Behaviour where this implementation is deliberately stricter than the reference polyfill,
// plus the native-API switch in signal.js. Each difference only affects programs that break a
// rule the proposal states (no reads/writes while the graph is frozen; computations are
// functions), so correct programs behave identically on both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Signal } from '../src/signal-impl.js';
import { Signal as Reference } from 'signal-polyfill';

test('reading a signal inside a watched hook throws instead of recursing forever', () => {
  // The reference polyfill re-enters the hook without end here (stack overflow).
  let error;
  const s = new Signal.State(0, {
    [Signal.subtle.watched]() {
      try { s.get(); } catch (caught) { error = caught; }
    },
  });
  new Signal.subtle.Watcher(() => {}).watch(s);
  assert.match(error.message, /cannot be read or written/);
});

test('writing a signal inside a watched/unwatched hook throws', () => {
  const other = new Signal.State(0);
  const errors = [];
  const hooks = {
    [Signal.subtle.watched]() { try { other.set(1); } catch (error) { errors.push(error.message); } },
    [Signal.subtle.unwatched]() { try { other.set(2); } catch (error) { errors.push(error.message); } },
  };
  const s = new Signal.State(0, hooks);
  const w = new Signal.subtle.Watcher(() => {});
  w.watch(s);
  w.unwatch(s);
  assert.equal(errors.length, 2);
  assert.equal(other.get(), 0);
});

test('reading a computed inside notify throws without poisoning its cached value', () => {
  // The reference starts recomputing before it notices the frozen graph, so the computed
  // caches the "read during notification" error and keeps throwing it afterwards.
  const run = (Impl) => {
    const s = new Impl.State(1);
    const c = new Impl.Computed(() => s.get() * 2);
    const w = new Impl.subtle.Watcher(() => { try { c.get(); } catch { /* forbidden */ } });
    w.watch(c);
    c.get();
    s.set(2);
    try { return c.get(); } catch { return 'poisoned'; }
  };
  assert.equal(run(Signal), 4);
  assert.equal(run(Reference), 'poisoned');
});

test('Signal.Computed requires a function', () => {
  assert.throws(() => new Signal.Computed(5), TypeError);
});

test('the API surface matches the proposal', () => {
  assert.deepEqual(Object.keys(Signal).sort(), ['Computed', 'State', 'subtle']);
  assert.deepEqual(Object.keys(Signal.subtle).sort(), [
    'Watcher', 'currentComputed', 'hasSinks', 'hasSources', 'introspectSinks', 'introspectSources',
    'untrack', 'unwatched', 'watched',
  ]);
  assert.equal(typeof Signal.subtle.watched, 'symbol');
  assert.ok(Object.isFrozen(Signal) && Object.isFrozen(Signal.subtle));
});

test('unwatched graphs keep no back-references (collectable, free on write)', () => {
  const s = new Signal.State(0);
  for (let i = 0; i < 1000; i++) new Signal.Computed(() => s.get() + i).get();
  assert.equal(Signal.subtle.hasSinks(s), false);
  assert.deepEqual(Signal.subtle.introspectSinks(s), []);
});

test('signal.js uses the native Signal when the platform provides one', async () => {
  const native = { State: class {}, Computed: class {}, subtle: {} };
  globalThis.Signal = native;
  try {
    const module = await import(`../src/signal.js?native=${Date.now()}`);
    assert.equal(module.Signal, native);
    assert.equal(module.isNative, true);
  } finally {
    delete globalThis.Signal;
  }
  const module = await import(`../src/signal.js?fallback=${Date.now()}`);
  assert.equal(module.Signal, Signal);
  assert.equal(module.isNative, false);
});

test('getPending lists computeds in the order they were marked, not the order they were watched', () => {
  const a = new Signal.State(0);
  const b = new Signal.State(0);
  const first = new Signal.Computed(() => a.get());
  const second = new Signal.Computed(() => b.get());
  first.get();
  second.get();
  const w = new Signal.subtle.Watcher(() => {});
  w.watch(first, second);
  b.set(1);
  a.set(1);
  // deepEqual can't tell two Computeds apart (no own properties), so compare by identity.
  const name = (c) => (c === first ? 'first' : c === second ? 'second' : '?');
  assert.deepEqual(w.getPending().map(name), ['second', 'first']);
});

test('getPending stays right when it is not called while computeds go stale and are read again', () => {
  const states = Array.from({ length: 100 }, () => new Signal.State(0));
  const computeds = states.map((s) => new Signal.Computed(() => s.get()));
  const w = new Signal.subtle.Watcher(() => {});
  w.watch(...computeds);
  for (let round = 1; round <= 50; round++) {
    states.forEach((s) => s.set(round));
    computeds.forEach((c) => c.get());
    w.watch();
  }
  states[7].set(-1);
  w.unwatch(computeds[7]); // stale while still listed: unwatching must drop it
  states[5].set(-1);
  const indexes = () => w.getPending().map((c) => computeds.indexOf(c));
  assert.deepEqual(indexes(), [5]);
  assert.deepEqual(indexes(), [5], 'getPending does not consume the list');
  computeds[5].get();
  assert.deepEqual(indexes(), []);
});
