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

## Server rendering

The comparison with WebUI, FAST, Enhance and WebC (`docs/compared-with-html-first.md`) measures server rendering against those four. The short version: Zubra's server parses each component again on every render, which makes it about 20 times slower than WebUI's on the same page.
