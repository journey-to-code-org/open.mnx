# Performance

Zubra's own size budgets and benchmarks run in CI (`runtime/test/tools/size.test.js` and `runtime/test/browser/bench.test.js`). They say whether Zubra got slower than itself. This page is about how it compares with others, measured in ways other people use.

## js-framework-benchmark

[js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) is the benchmark most frameworks are compared on. It defines one app, a table of rows and six buttons, and times nine operations on it. Zubra's implementation is in [`benchmarks/js-framework-benchmark/frameworks/keyed/zubra`](../benchmarks/js-framework-benchmark/frameworks/keyed/zubra), in the benchmark's own layout. It is one `.zb` file written the way the guide teaches:

- `let rows`, mutated in place (`rows[i].label += ' !!!'`, `rows.splice(…)`);
- a keyed `zb-each`;
- `onclick` on each link, not one delegated handler.

**Status: ready to submit, not yet submitted.** Until it's merged upstream and appears in the official results, there are no official numbers. The official runner reads Chrome's traces, throttles the CPU for some operations, and repeats each many times on a quiet machine. Its results are the ones to quote, and this page will link them.

**Checked in CI.** `benchmarks/js-framework-benchmark/run.mjs` runs the nine operations with the benchmark's own selectors and checks: the warmups, then the measured step and its check. It fails if any check fails or the page logs an error (the `benchmark` job).

### Measured locally, not the official method

`node run.mjs --time --compare <checkout> vanillajs lit` times each operation from the click to the frame after it, with `requestAnimationFrame`. Same machine, same run, Chromium without throttling, median of nine runs. It's good for comparing implementations side by side, and for finding where Zubra is slow; it isn't the benchmark's score. Zubra 5.7.0, measured 2026-11-12, beside the benchmark's hand-written JavaScript (`vanillajs`) and Lit 3:

| Operation | Zubra | vanilla JS | Lit |
|---|---|---|---|
| create rows | 88.0 | 51.5 | 70.1 |
| replace all rows | 122.0 | 51.9 | 67.1 |
| partial update | 14.2 | 9.6 | 14.8 |
| select row | 9.5 | 8.1 | 10.6 |
| swap rows | 60.7 | 13.6 | 14.8 |
| remove row | 18.8 | 15.8 | 15.6 |
| create many rows | 1,046.5 | 595.8 | 676.9 |
| append rows to large table | 105.6 | 52.2 | 65.3 |
| clear rows | 17.2 | 5.9 | 6.2 |

Milliseconds; lower is better. What it says:

- **Updates are on a par with Lit:** partial update, select and remove. That's fine-grained reactivity doing its job.
- **Swapping two rows is four times slower than Lit.** A keyed `zb-each` walks the new order and moves every row that isn't where the walk expects. A swap of rows 2 and 999 therefore moves every row in between, about a thousand moves for what should be two. Keeping the longest run of rows already in order, as most keyed renderers do, fixes it.
- **Creating, replacing and clearing rows are 1.3 to 3 times slower than Lit.** Each row costs two comment markers and its own effect scope, and clearing disposes each. These need profiling before a fix.

When the official results exist, they replace this table.

## The Signals core

Compiled components get their reactivity from `runtime/src/signal-impl.js`, Zubra's implementation of the TC39 Signals API (the native `Signal` replaces it where a browser has one). Profiling the benchmark's create and clear found most of the runtime's own time, and most of its garbage collection, in that file and in `effect.js`. Three things cost it, all fixed without changing the API:

- **A `WeakMap` from each signal to its internal node.** A `WeakMap` with tens of thousands of keys is a table the garbage collector walks on every collection. Each signal now holds its node in a private field, which is also the check that a method was called on the right kind of object.
- **`Watcher.getPending()` looked at every watched signal.** Zubra's effects share one Watcher and call `getPending()` on each flush, the pattern the proposal's README shows, so every update cost something for every effect on the page. The Watcher now records computeds as they're marked dirty: O(pending), not O(watched). The one visible difference is the order, listed in `runtime/README.md`.
- **Allocation:** five arrays per node made up front, and a `Set` of children per effect, though most have none. Both are now made on first use.

Measured in Node (median ms, each case in a fresh process), against the polyfill and the two fastest signals libraries, which have their own APIs:

| Case | Before | After | signal-polyfill | alien-signals 3 | Preact signals |
|---|---|---|---|---|---|
| create and dispose 2,000 effects | 14–20 | 3.2–4.3 | 12–20 | 0.14–0.24 | 0.24–0.39 |
| 1 write, 1,000 watching effects, 2 re-run | 0.44–0.78 | 0.12–0.13 | 0.39–0.60 | 0.03 | 0.03 |
| 1 state → 1,000 computeds → effects | 0.6–0.85 | 0.28–0.43 | 0.48–0.54 | 0.05–0.06 | 0.06–0.09 |

The rest of the gap to alien-signals is the API's shape: an effect on the proposal is a `Computed` plus a Watcher entry, about ten objects, where alien-signals' is two. A WebAssembly core was tried too and isn't a way round it: a call into WebAssembly costs about twice a JavaScript call, and a signals core is nothing but small calls.

In the benchmark, with `run.mjs --time --runs 9` (same machine, same run, before and after this change; differences under about 15% are noise on this machine):

| Operation | vanilla JS | Before | After |
|---|---|---|---|
| create rows | 85.5 | 137.1 | 99.5 |
| replace all rows | 66.3 | 148.8 | 126.8 |
| select row | 9.3 | 15.5 | 5.7 |
| create many rows | 794.2 | 1,437.2 | 1,332.5 |
| append rows to large table | 91.6 | 140.7 | 123.3 |
| clear rows | 9.0 | 23.7 | 16.9 |

What's left in creating and clearing rows is mostly the DOM work each row does: two comment markers and a fragment, `importNode`, `textContent`, and an effect per binding.

### Rows

A row `zb-each` makes in the browser is now its block's own nodes, with no comment markers and no fragment of its own; rows the server rendered keep their markers, so hydration is unchanged. A block with no custom elements is copied into the document once and each row clones that copy (a block with one still uses `importNode`, so its elements upgrade before their props are bound). A text binding on an element holding one Text node compares and writes that node's `.data`. Same run, before and after:

| Operation | vanilla JS | Solid | Before | After |
|---|---|---|---|---|
| create rows | 82.3 | 72.2 | 105.1 | 112.3 |
| replace all rows | 82.4 | 67.0 | 125.4 | 110.4 |
| create many rows | 734.9 | 821.7 | 1,260.3 | 1,198.5 |
| append rows to large table | 84.6 | 95.1 | 151.7 | 114.0 |
| clear rows | 8.5 | 6.8 | 24.4 | 16.7 |

Create rows and remove row moved within this machine's noise (about 15%). A CPU profile of creating and clearing 1,000 rows, which is steadier, puts the DOM calls Zubra makes at 20–24 ms a cycle, from 28. Its JavaScript didn't move (22–26 ms, against about 7 for hand-written JS): that's an effect per binding and finding each binding's node by its path at runtime, the next piece of work.

## Server rendering

The comparison with WebUI, FAST, Enhance and WebC (`docs/compared-with-html-first.md`) measures server rendering against those four. The short version: Zubra's server parses each component again on every render, which makes it about 20 times slower than WebUI's on the same page.
