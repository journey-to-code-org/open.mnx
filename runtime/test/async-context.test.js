// Spike (ECMAScript roadmap E4, approach 2): tracking reads after an `await` with AsyncContext,
// to show the Signals and AsyncContext champions what a framework needs. Nothing here ships.
//
// Node's AsyncLocalStorage stands in for `AsyncContext.Variable` (it is what the proposal's
// polyfills use in Node). Two levels are measured:
//
// 1. AsyncContext alone. The run follows the fetcher across `await`, so `track()` no longer has
//    to be passed down: a helper in another module can find the run. But a read is still
//    followed only if it goes through `track()`, because the Signals API records a read only
//    while a Computed is running, and nothing makes the code after an `await` one.
// 2. AsyncContext plus one hook in Signals: a read made while no Computed is running is
//    reported to the consumer in the async context. Then an unmodified fetcher is followed,
//    with no compiler and no `track()`, reads inside imported helpers included. The hook is a
//    few lines in the polyfill's `get()`; here it is patched onto the prototypes for the test.
import { test as nodeTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Signal } from '../src/signal.js';
import { scope, tick } from '../src/effect.js';
import { resource } from '../src/resource.js';
import { tracked } from '../src/track.js';

class Variable {
  #storage = new AsyncLocalStorage();
  run(value, fn, ...args) { return this.#storage.run(value, fn, ...args); }
  get() { return this.#storage.getStore(); }
}
const AsyncContext = { Variable };

const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);
const later = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async () => { await later(); await tick(); await later(); await tick(); };

// ---- 1. AsyncContext alone ------------------------------------------------------------------

/** The running fetcher's `track`, carried across `await` by the async context. */
const currentTrack = new AsyncContext.Variable();

/** `tracked()`, with the run's `track` put in the async context for the fetcher. */
function asyncTracked(fetcher) {
  return tracked((run) => currentTrack.run(run.track, fetcher, run));
}

/** For code that wasn't handed `track`: follows the read if a fetcher's run is in context. */
function trackHere(read) {
  const track = currentTrack.get();
  return track ? track(read) : read();
}

// "Another module": a helper with no parameter for the run.
const page = new Signal.State(1);
const currentPage = () => trackHere(() => page.get());

test('AsyncContext alone: a helper finds the run after an await, but has to call track()', async () => {
  page.set(1);
  const pages = [];
  const owner = scope(() => {
    resource(asyncTracked(async () => {
      await later();
      pages.push(currentPage());
    }));
  });
  await settle();
  page.set(2);
  await settle();
  assert.deepEqual(pages, [1, 2], 'the helper reached the run without being passed it');

  // The same read written plainly is not followed: Signals don't consult the async context.
  const other = new Signal.State('a');
  let runs = 0;
  const owner2 = scope(() => {
    resource(asyncTracked(async () => { runs++; await later(); return other.get(); }));
  });
  await settle();
  other.set('b');
  await settle();
  assert.equal(runs, 1);
  owner.dispose();
  owner2.dispose();
});

// ---- 2. AsyncContext plus a hook in Signals --------------------------------------------------

/**
 * The hook a Signals implementation would need: a read with no Computed running is reported to
 * the async context's consumer. Patched onto the polyfill's prototypes, and undone after.
 */
const asyncConsumer = new AsyncContext.Variable();
const originals = [];
for (const Kind of [Signal.State, Signal.Computed]) {
  const get = Kind.prototype.get;
  originals.push([Kind, get]);
  Kind.prototype.get = function () {
    const consumer = Signal.subtle.currentComputed() ? undefined : asyncConsumer.get();
    return consumer ? consumer(() => get.call(this)) : get.call(this);
  };
}
after(() => { for (const [Kind, get] of originals) Kind.prototype.get = get; });

/**
 * `tracked()`, with the run as the async context's consumer: no `track()` calls needed. The
 * consumer clears the context while it works: its own `computed.get()` also runs outside any
 * Computed, and would be reported back to it, forever (the first version of this spike hung).
 */
function contextTracked(fetcher) {
  return tracked((run) => {
    const consumer = (read) => asyncConsumer.run(undefined, run.track, read);
    return asyncConsumer.run(consumer, fetcher, run);
  });
}

test('with the hook: an unmodified fetcher is followed after its await, helpers included', async () => {
  const id = new Signal.State(1);
  const size = new Signal.State(10);
  const pageSize = () => size.get(); // a plain helper, no tracking of its own
  const calls = [];
  const owner = scope(() => {
    resource(contextTracked(async () => {
      const user = id.get();
      await later();
      calls.push(`${user}:${pageSize()}`);
    }));
  });
  await settle();
  size.set(20);
  await settle();
  id.set(2);
  await settle();
  assert.deepEqual(calls, ['1:10', '1:20', '2:20']);
  owner.dispose();
});

test('with the hook: a replaced run’s late reads and a timer left behind still do not subscribe', async () => {
  const trigger = new Signal.State(0);
  const stale = new Signal.State(0);
  const late = new Signal.State(0);
  const gates = [];
  let runs = 0;
  const owner = scope(() => {
    resource(contextTracked(async () => {
      const first = runs++ === 0;
      trigger.get();
      await new Promise((resolve) => gates.push(resolve));
      if (first) stale.get();
      // The async context follows the timer too: the run must refuse it, since it has settled.
      if (first) setTimeout(() => late.get(), 10);
      return null;
    }));
  });
  trigger.set(1);
  await tick();
  gates[1]();
  await settle();
  gates[0]();
  await settle(); await later(); await later();
  const before = runs;
  stale.set(1);
  late.set(1);
  await settle();
  assert.equal(runs, before);
  assert.equal(Signal.subtle.hasSinks(late), false, 'the timer’s read, in the context, was refused');
  owner.dispose();
});

test('with the hook, outside any fetcher nothing changes', () => {
  const plain = new Signal.State(3);
  assert.equal(asyncConsumer.get(), undefined);
  assert.equal(plain.get(), 3);
  assert.equal(Signal.subtle.hasSinks(plain), false);
});

test('with the hook as patched here, untrack() after an await is not respected (the real hook must be)', async () => {
  // A patch on `get()` can't tell "no Computed is running" from "untrack() said not to track":
  // both look the same through the public API. Inside the implementation they differ (untrack
  // sets the consumer to null on purpose), so the hook belongs there, not in a library.
  const ignored = new Signal.State(0);
  let runs = 0;
  const owner = scope(() => {
    resource(contextTracked(async () => {
      runs++;
      await later();
      return Signal.subtle.untrack(() => ignored.get());
    }));
  });
  await settle();
  ignored.set(1);
  await settle();
  assert.equal(runs, 2, 'followed, though the fetcher asked not to: recorded as a requirement');
  owner.dispose();
});
