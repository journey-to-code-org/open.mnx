// Signal bridges: read (and write) a Zubra signal from a framework's own code.
//
//   import { shared } from './cart-state.js'               // export const shared = state([])
//   import { toStore } from '@zubra/runtime/bridge'
//   const cart = toStore(shared, { deep: true })
//
//   Svelte:   {$cart.length}                               (the store contract)
//   Solid:    const items = from(cart)                     (solid-js `from`)
//   Angular:  items = toSignal(cart, { requireSync: true })  (a Subscribable)
//   RxJS:     from(cart)                                   (Symbol.observable)
//   React:    useSignal(shared) from '@zubra/runtime/react'
//   Vue:      useSignal(shared) from '@zubra/runtime/vue'
//
// The adapters carry props, events and two-way bindings across the element boundary; this
// carries state: a signal that elements and the app's code both read, without copying it into
// the framework's state and back. Any `Signal.State` or `Signal.Computed` works (`state()`,
// `computed()`, `from()`, a `@zubra/sync` field, a native `Signal` once browsers ship one), as
// does a function that reads signals (it's tracked like a computed).
//
// `deep: true` also tracks what's inside an array or plain object, so `items.push(x)` notifies
// as `items = [...items, x]` does. Without it a mutation inside the value isn't a change.
import { Signal } from './signal.js';
import { effect, root } from './effect.js';

const isSignal = (value) => value instanceof Signal.State || value instanceof Signal.Computed;

function check(source, name) {
  if (typeof source !== 'function' && !isSignal(source)) {
    throw new TypeError(`zubra: ${name}() needs a signal (state(), computed(), a Signal.State or Signal.Computed) or a function that reads signals`);
  }
}

/** The source's current value: a signal's `get()`, or the function's result. */
export const read = (source) => (typeof source === 'function' ? source() : source.get());

/** Whether the source can be written: a `Signal.State`, or a signal with its own `set` (`from()`). */
export const writable = (source) => typeof source?.set === 'function';

// Read every property of an array or plain object (through state's proxy, each read is tracked),
// so a change anywhere inside notifies.
function touch(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  if (!Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return;
  }
  seen.add(value);
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) touch(value[index], seen);
  else for (const key of Object.keys(value)) touch(value[key], seen);
}

/**
 * Call `callback(value)` now and whenever `source` changes, until the returned function is
 * called. Changes are batched like the runtime's own effects: one call per microtask, with the
 * latest value. Not owned by any component, so it lives until it's unsubscribed.
 */
export function subscribe(source, callback, { deep = false } = {}) {
  check(source, 'subscribe');
  const owner = root(() => {
    effect(() => {
      const value = read(source);
      if (deep) touch(value);
      Signal.subtle.untrack(() => callback(value));
    });
  });
  return () => owner.dispose();
}

/**
 * The source as a store: the Svelte store contract (`subscribe(run)` calls `run` now and on each
 * change, returning the unsubscribe function), which is also an RxJS-style Subscribable
 * (`subscribe({ next })` returns something with `unsubscribe()`), so Angular's `toSignal`, Solid's
 * `from` and RxJS's `from` take it as it is. `set` and `update` are there when the source is
 * writable (a Svelte writable store, so `bind:value={$store}` works).
 */
export function toStore(source, options = {}) {
  check(source, 'toStore');
  const store = {
    get: () => read(source),
    subscribe(run) {
      const next = typeof run === 'function' ? run : (value) => run?.next?.(value);
      const stop = subscribe(source, next, options);
      const unsubscribe = () => stop();
      unsubscribe.unsubscribe = unsubscribe;
      return unsubscribe;
    },
    [Symbol.observable ?? '@@observable']() {
      return this;
    },
  };
  if (writable(source)) {
    store.set = (value) => source.set(value);
    store.update = (fn) => source.set(fn(Signal.subtle.untrack(() => read(source))));
  }
  return store;
}
