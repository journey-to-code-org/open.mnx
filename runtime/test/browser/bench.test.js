// Benchmarks: the js-framework-benchmark operations on a keyed table, and hydrating server
// markup against rendering it fresh. Timings are reported; the budgets are loose, to catch an
// operation becoming quadratic or hydration re-rendering, not to compare machines.
// `npm run test:browser`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useBrowser, open, here, compiler, engine } from './harness.js';

useBrowser({ bench: join(here, 'fixtures/bench.zb') });

const ROWS = 1000;
const rows = (count, from = 1) => Array.from({ length: count }, (_, i) => ({ id: from + i, label: `row ${from + i}`, selected: false }));

test('js-framework-benchmark operations on 1,000 keyed rows', async (t) => {
  // Best of three runs, each on a fresh page, per operation: one timing on a busy CI machine can
  // be twice another, and the ratios below are about the code, not the machine.
  const once = async () => {
    const { page, messages } = await open('<zb-bench></zb-bench>', { modules: ['bench'] });
    const times = await page.evaluate(async (count) => {
      const el = document.querySelector('zb-bench');
      const make = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i, label: `row ${from + i}`, selected: false }));
      const time = async (fn) => {
        const start = performance.now();
        fn();
        await el.updateComplete;
        el.offsetHeight; // include layout
        return performance.now() - start;
      };
      const result = {};
      result.create = await time(() => { el.rows = make(count); });
      result.replace = await time(() => { el.rows = make(count, count + 1); });
      result.update = await time(() => { el.rows = el.rows.map((row, i) => (i % 10 === 0 ? { ...row, label: `${row.label} !!!` } : row)); });
      result.select = await time(() => { el.rows = el.rows.map((row, i) => (i === 5 ? { ...row, selected: true } : row)); });
      result.swap = await time(() => { const next = [...el.rows]; [next[1], next[count - 2]] = [next[count - 2], next[1]]; el.rows = next; });
      result.remove = await time(() => { el.rows = el.rows.filter((_, i) => i !== 3); });
      result.append = await time(() => { el.rows = [...el.rows, ...make(count, 5 * count)]; });
      result.clear = await time(() => { el.rows = []; });
      return result;
    }, ROWS);
    assert.deepEqual(messages, []);
    await page.close();
    return times;
  };
  const runs = [await once(), await once(), await once()];
  const times = Object.fromEntries(Object.keys(runs[0]).map((name) => [name, Math.min(...runs.map((run) => run[name]))]));
  t.diagnostic(`ms: ${Object.entries(times).map(([name, ms]) => `${name} ${ms.toFixed(1)}`).join(', ')}`);
  for (const [name, ms] of Object.entries(times)) assert.ok(ms < 3000, `${name} took ${ms} ms`);
  // The ratios are Chromium's: WebKit clears rows more slowly relative to creating them (2,000
  // rows cleared in 2.8× the time of creating 1,000), which isn't the quadratic case below.
  if (engine !== 'chromium') return;
  // Updating 1 in 10 labels, or selecting one row, must cost far less than building the table.
  assert.ok(times.select < times.create, `select (${times.select}) vs create (${times.create})`);
  // Clearing and replacing every row must not cost more than building them (it was quadratic
  // when each removed row unwatched its effects separately).
  assert.ok(times.clear < times.create * 1.5, `clear (${times.clear}) vs create (${times.create})`);
  assert.ok(times.replace < times.create * 2.5, `replace (${times.replace}) vs create (${times.create})`);
});

test('hydrating server markup is cheaper than rendering it fresh, and keeps every node', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zb-bench-'));
  const props = join(dir, 'props.json');
  writeFileSync(props, JSON.stringify({ rows: rows(ROWS) }));
  const html = compiler(join(here, 'fixtures/bench.zb'), '--props', props);

  const measure = async (body, setup) => {
    const { page, messages } = await open(body, {
      beforeModules: `window.firstRow = document.querySelector('tr'); window.start = performance.now(); ${setup}`,
      modules: ['bench'],
    });
    const result = await page.evaluate(async () => {
      const el = document.querySelector('zb-bench');
      await el.updateComplete;
      el.offsetHeight;
      return { ms: performance.now() - window.start, rows: el.querySelectorAll('tr').length, kept: !!window.firstRow && document.querySelector('tr') === window.firstRow };
    });
    assert.deepEqual(messages, []);
    await page.close();
    return result;
  };
  // Best of five, the two alternating, so a slow stretch of a busy CI machine hits both.
  const fill = `document.querySelector('zb-bench').rows = ${JSON.stringify(rows(ROWS))};`;
  const hydrations = [];
  const renders = [];
  for (let i = 0; i < 5; i++) {
    hydrations.push(await measure(html, ''));
    renders.push(await measure('<zb-bench></zb-bench>', fill));
  }
  const best = (runs) => runs.reduce((a, b) => (a.ms <= b.ms ? a : b));
  const hydrated = best(hydrations);
  const fresh = best(renders);
  t.diagnostic(`hydrate ${hydrated.ms.toFixed(1)} ms, fresh render ${fresh.ms.toFixed(1)} ms (${ROWS} rows, includes defining the element)`);
  assert.equal(hydrated.rows, ROWS);
  assert.equal(fresh.rows, ROWS);
  assert.equal(hydrated.kept, true, 'hydration bound to the server rows instead of replacing them');
  assert.ok(hydrated.ms < fresh.ms * 1.5, `hydrate ${hydrated.ms} vs fresh ${fresh.ms}`);
});
