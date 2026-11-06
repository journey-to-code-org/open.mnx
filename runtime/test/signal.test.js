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
