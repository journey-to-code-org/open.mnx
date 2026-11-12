# Signals in production: an integration report for the TC39 proposal

*Zubra 5.0.3, November 2026. For the [Signals proposal](https://github.com/tc39/proposal-signals) champions. The proposal is at Stage 1. Before Stage 2 its authors want production-grade polyfills, and integrations into frameworks tested in real applications. This report is one of each.*

## What Zubra is

Zubra compiles HTML-first single-file components (and JSX function components) into custom elements. All of its reactivity is the proposal's API.

- **Props.** Each prop is a `Signal.State`.
- **Script values.** `state()` returns a `Signal.State` and `computed()` a `Signal.Computed`.
- **Templates.** Every binding is an effect built on one `Signal.subtle.Watcher`.
- **Async data.** `resource()` is a few signals and one effect.

When `globalThis.Signal` exists, Zubra uses it; otherwise it uses its own implementation (`runtime/src/signal-impl.js`). Compiled code never touches anything that isn't in the proposal, so a native implementation would delete code from Zubra without changing any component.

## The implementation, and how it is checked

- **A second implementation of the API**, written from the README and the reference polyfill. It is about 375 lines and has no dependencies. Dependency bookkeeping is positional, with back-indices, so unlinking is O(1).
- **Differential tests** against [`signal-polyfill`](https://github.com/proposal-signals/signal-polyfill). Each scenario runs against both implementations and the logs must be identical, including the order in which watchers are notified and `watched`/`unwatched` hooks fire. The scenarios are hand-written ones plus 300 seeded random graphs (data-dependent branches, errors, two watchers, random watch/unwatch). A run of 5,000 seeds also matches (5,026 tests, re-run for 5.0.3; change `seed <= 300` in `runtime/test/differential.test.js` to reproduce it).
- **Used under load** by everything above, in the browser suites (Chromium) and in real Vite, Rollup, webpack and esbuild apps with React 18/19, Vue 3, Svelte 5, Solid, Lit, Angular and Astro.

## Findings for the proposal

### Two reference-polyfill behaviours that the README rules out

Zubra deliberately behaves differently in both cases, and tests it in `runtime/test/signal.test.js`.

1. **A `watched` hook that reads its own signal recurses until the stack overflows.** The README says the graph is frozen while hooks run. The reference doesn't enforce that, so a read re-enters liveness tracking. Zubra throws on any read or write inside `watched`/`unwatched`.
2. **Reading a computed inside a Watcher's `notify` poisons it.** The reference starts recomputing before it detects the forbidden read. The computed then caches the "read during notification" error and keeps throwing it after the notification is over. Zubra throws before recomputing, so the computed stays usable.

We propose that the spec text (or the polyfill's tests) cover both. Each is a few lines and makes the frozen-graph rule observable.

### `Watcher.unwatch` cost needs a note: batch it

Unwatching scans the watcher's sources, so unwatching n effects one at a time costs O(n²). A framework that disposes or pauses a subtree (a list of 1,000 rows removed at once) hits this. In Zubra it made clearing 1,000 rows take 112 ms against 47 ms to create them.

The fix is the API's own variadic form. Zubra collects what a subtree disposes and calls `unwatch(...signals)` once. On the same benchmark (`runtime/test/browser/bench.test.js`, 1,000 keyed rows, Chromium, best of three) clearing now takes 28.7 ms against 44.0 ms to create, and the test fails if it exceeds 1.5 times the creation. One detail for the README: spreading a very large list into the variadic call can hit the engine's argument-count limit, so Zubra unwatches in chunks of 10,000. We suggest the README say so where it shows the effect pattern, because every framework will write the one-at-a-time version first.

### Effects need ownership, and ownership needs pausing

The proposal leaves effects to libraries, rightly. Every component framework needs the same three things on top, and they are easy to get wrong:

1. **Ownership.** An effect created inside another belongs to it, and is disposed when the parent re-runs or is disposed.
2. **Pausing.** A detached element's effects are unwatched, so long-lived signals hold no reference to them, but they keep their cached state. On re-attach, only effects whose sources changed re-run. The version check in `Signal.Computed` already makes this nearly free.
3. **Batched re-runs** in a microtask.

Zubra's version is `runtime/src/effect.js` (about 230 lines, documented). We'd suggest a shared "effects on Signals" pattern document, so frameworks converge.

The leak suite (`runtime/test/browser/leaks.test.js`) checks the property that matters: removed elements, including ones reading a signal that outlives them, are garbage-collected. It counts live instances through the DevTools protocol.

### Fine-grained state for objects and arrays is a `Signal.State` per property

A script value holding an array or a plain object holds a proxy of it. Each property read through the proxy is tracked by its own `Signal.State`, created on the first read, and each write bumps that property's signal, so only what read the property re-runs. Nested arrays and objects are wrapped when they are read. That is the whole mechanism (`runtime/src/deep.js`, about 200 lines): it adds nothing to the API. Class instances, `Map`, `Set`, dates and promises are left unwrapped because a proxy would break their internals.

It is the shape people reach for when they ask the proposal for collections or "deep" state. It works over the standard API, with the usual proxy limits (identity, and the types it must skip). We would suggest that any shared guidance on this pattern say so, and we can say that it needed no new primitive.

### Reads after an `await`

`resource(fetcher)` runs the fetcher inside an effect, so what it reads before its first `await` is tracked. The code after that runs later, outside any Computed, and the API records a read only while a Computed is running. So those reads were untracked, as in every framework, and it was the most common surprise. We measured two ways around it (ECMAScript roadmap E4; tests in `runtime/test/resource-await.test.js` and `runtime/test/async-context.test.js`).

**What ships (experimental): a per-run `track()`, written by the compiler.** `tracked(fetcher)` (`@zubra/runtime/track`, about 570 B gzipped, loaded only by components that use it) gives each run `track(read)`. After an `await`, `track` evaluates `read` in a new `Signal.Computed`. An effect watches those Computeds, and when one's value changes it runs the fetcher again. In a `.zb` script the compiler knows every prop and state read, so it writes `$run.track(() => page.get())` around the ones that can run after the first `await`: reads in the `await`'s operand, before it waits, stay plain, while reads in a loop that awaits and reads in nested functions are tracked. It works on the standard API alone. What it can't reach is a read the compiler doesn't see, such as a store's getter in another module.

Building it settled four rules. A framework doing this needs each of them, whatever carries the context:

1. **A replaced run still reads, but doesn't subscribe.** Its late reads describe a value that will be dropped.
2. **A settled run doesn't subscribe either.** A timer or listener the fetcher left behind can't change the value the run already produced. With AsyncContext this matters more, since the context follows the timer.
3. **A new read is appended without re-running.** Only a value that differs from the one the run saw counts.
4. **The watching has an owner.** A detached element holds none of the reads, and catches up when it returns.

**AsyncContext alone doesn't remove the problem.** With `AsyncContext.Variable` (Node's `AsyncLocalStorage` standing in), the run follows the fetcher across `await`, so a helper in another module can find it and call `track()` without being handed it. But a plain `signal.get()` after the `await` is still not followed: the Signals API doesn't consult the async context.

**AsyncContext plus one hook in Signals does.** The hook: a `get()` made while no Computed is running reports the read to a consumer held in an `AsyncContext.Variable`. With it, an unmodified async fetcher is followed after its `await`, reads in imported helpers included, with no compiler. The spike patches the hook onto the polyfill's prototypes and found two things it needs:

- **The consumer must run with the context cleared.** Its own bookkeeping reads also happen outside any Computed, and they were reported back to it, forever. The first version hung.
- **It has to respect `untrack()`.** Through the public API, "no Computed is running" and "`untrack()` said not to track" look the same, so a library patch follows reads the code asked not to follow (the spike's last test records this). Inside the implementation the two differ, so the hook belongs in the Signals implementation, not in a library.

What we'd ask of the champions: consider an async consumer, so that a Computed or effect started by a framework keeps receiving reads across `await` through AsyncContext, with `untrack()` excluding them. Until then, a compiler can do the same for the reads it can see. That is the measured cost of not having it: a closure per read after an `await`, and reads in other modules missed.

## What we didn't need

We used `Signal.subtle.currentComputed` in one place: `track()` asks whether a Computed is running, to leave a read before the first `await` to the effect. The introspection APIs are used only in tests and the DevTools pane. `untrack` is used in a handful of places, in four kinds: running user callbacks (`watch()` callbacks and effect cleanups), mounting blocks or effects inside an effect without the parent depending on what they read, reading a value's latest state when it is being reassigned (a prop that resets to a new default and can still be written locally), and assigning element references.

## Reproducing

```sh
cd runtime && npm ci
node --test test/signal.test.js test/differential.test.js   # the implementation and the comparison
npm run test:browser                                         # Chromium: components, leaks, benchmarks
```
