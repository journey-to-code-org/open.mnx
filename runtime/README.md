# @mnx/runtime

The browser runtime that compiled mnx components run on. It is a **polyfill boundary**: everything
compiled code depends on is shaped like a proposed web platform primitive, so when the platform
ships one, this package deletes code instead of components being rewritten.

| Module | Shaped like | Status |
|---|---|---|
| `src/signal.js` | [TC39 Signals](https://github.com/tc39/proposal-signals) (`Signal.State`, `Signal.Computed`, `Signal.subtle`) | Done. Uses native `globalThis.Signal` when present, otherwise `src/signal-impl.js` |
| `src/effect.js` | Not a proposal — the Signals proposal leaves effects to libraries. Built only on `Signal.subtle.Watcher` and microtasks | Done |
| template parts (`walk`/`bind`) | [DOM Parts](https://github.com/WICG/webcomponents/blob/gh-pages/proposals/DOM-Parts.md) | Next (0.4) |
| `define` | Custom elements, light DOM by default | Next (0.4), rebuilt from wc.js v4 on these signals |

## Signals

`src/signal-impl.js` is an independent implementation of the proposed API. It is held to the
proposal's reference polyfill, [`signal-polyfill`](https://github.com/proposal-signals/signal-polyfill),
by **differential tests**: each scenario runs against both, and the logs must be identical,
including values, recompute counts, the order watchers are notified, the order `watched` and
`unwatched` hooks fire, pending lists and introspection.

- 26 hand-written scenarios: caching, equality cut-off, glitch-free diamonds, dynamic
  dependencies, cached errors, cycles, `equals` semantics, watcher re-arming, frozen-graph rules,
  liveness hooks, introspection, receiver checks.
- 300 seeded random graphs (states, computeds with data-dependent branches and errors, two
  watchers, random reads, writes, watch/unwatch). A one-off run of 5,000 seeds also matched.

### Deliberate differences from the reference polyfill

Each one only affects programs that break a rule the proposal states, so correct programs
behave the same on both. All are tested in `test/signal.test.js`.

1. **Reads and writes inside `watched`/`unwatched` hooks throw.** The proposal says hooks run
   with the graph frozen; the reference doesn't enforce it, and a hook that reads its own signal
   recurses until the stack overflows.
2. **Reading a computed inside a Watcher's `notify` throws before recomputing.** The reference
   starts recomputing first, so the computed caches the "read during notification" error and
   keeps throwing it after the notification is over.
3. **`new Signal.Computed(x)` requires a function** (TypeError), instead of failing on first read.

## Effects

```js
import { Signal } from '@mnx/runtime/signal';
import { effect, scope, flush, tick } from '@mnx/runtime/effect';

const count = new Signal.State(0);
const dispose = effect(() => {
  console.log(count.get());
  return () => { /* cleanup before the next run, and on dispose */ };
});
count.set(1); count.set(2);   // one re-run, in a microtask
await tick();
```

- **Batched**: any number of writes in a task cause one re-run per effect.
- **Owned**: an effect created inside another effect (or a `scope`) is disposed when its owner
  re-runs or is disposed. A child's reads never become its parent's dependencies.
- **Ordered**: parents re-run before children; a child replaced by its parent never runs.
- **Isolated**: an error in a re-run is reported (`reportError`, else `console.error`) and the
  other effects still run. Effects that keep re-triggering each other are stopped after 100
  rounds.
- **Pausable**: `scope.pause()` (an element left the DOM) unwatches everything inside it, so
  long-lived signals hold no reference to it; `scope.resume()` re-runs only the effects whose
  inputs changed while paused. This is wc.js v4's leak fix, now provided by `Signal.Computed`'s
  own version checks.

A write to a signal an effect has already read in the same run does not re-run it (same as a
computed in the reference). Derive the value instead of writing it back.

## Tests

```sh
npm install
npm test
```

The effect tests were mutation-checked: removing the parent-first sort, the `untrack` around
child runs, child disposal on re-run, or unwatching on pause each makes at least one test fail.
