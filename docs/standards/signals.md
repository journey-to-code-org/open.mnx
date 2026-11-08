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

### Reads before the first `await`

`resource(fetcher)` tracks what the fetcher reads synchronously. Reads after its first `await` are untracked, as in every framework. This works, but it's the most common surprise. An `AsyncContext` integration (tracking across `await`) would remove it, which supports the champions' interest in that direction.

## What we didn't need

We never used `Signal.subtle.currentComputed` or the introspection APIs in shipped code; only tests use them. `untrack` is used in a handful of places, in four kinds: running user callbacks (`watch()` callbacks and effect cleanups), mounting blocks or effects inside an effect without the parent depending on what they read, reading a value's latest state when it is being reassigned (a prop that resets to a new default and can still be written locally), and assigning element references.

## Reproducing

```sh
cd runtime && npm ci
node --test test/signal.test.js test/differential.test.js   # the implementation and the comparison
npm run test:browser                                         # Chromium: components, leaks, benchmarks
```
