// Runs the js-framework-benchmark's nine CPU operations against implementations in its layout
// (frameworks/keyed/<name>/), in Chromium, with the benchmark's own checks after each step.
//
//   node run.mjs                                   # frameworks/keyed/zubra here: checks only
//   node run.mjs --time [--runs 15]                # and times each operation
//   node run.mjs --time --compare <benchmark-checkout> vanillajs lit
//                                                  # the same, beside implementations from a
//                                                  # checkout of krausest/js-framework-benchmark
//                                                  # (built there first; its css/ is served)
//
// This is not the benchmark's own runner. That one reads Chrome's trace, applies CPU throttling for
// some operations and runs each many times on a quiet machine; its results are the ones to quote.
// This times from the click to the frame after it (script, style, layout and paint, measured with
// requestAnimationFrame), so it is good for comparing implementations on one machine in one run,
// and for checking an implementation before submitting it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const TIME = args.includes('--time');
const RUNS = Number(option('--runs', 15));
const compare = option('--compare');
const others = compare ? args.slice(args.indexOf('--compare') + 2).filter((arg) => !arg.startsWith('--')) : [];

/** The benchmark's CSS: from a checkout when comparing, otherwise none (the checks don't need it). */
const cssRoot = compare ? resolve(compare) : null;
const implementations = [
  { name: 'zubra', dir: join(here, 'frameworks/keyed/zubra') },
  ...others.map((name) => ({ name, dir: join(resolve(compare), 'frameworks/keyed', name) })),
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
function serve() {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    const [, name, ...rest] = path.split('/');
    let file = name === 'css' && cssRoot ? join(cssRoot, path) : join(implementations.find((i) => i.name === name)?.dir ?? '/nonexistent', ...rest);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

// The benchmark's selectors and checks (webdriver-ts/src/benchmarksPlaywright.ts), run in the page.
// The operations below are serialized into the page, so what they use is defined there too.
const IN_PAGE = `
  window.WARMUP = 5;
  window.row = (n, cell) => 'tbody>tr:nth-of-type(' + n + ')>td:nth-of-type(' + cell + ')';
  window.$bench = {
    // Implementations marked useShadowRoot (Lit's) render inside main-element's shadow root.
    root: () => document.querySelector('main-element')?.shadowRoot ?? document,
    q(selector) { return this.root().querySelector(selector); },
    all(selector) { return this.root().querySelectorAll(selector); },
    text(selector) { return this.q(selector)?.textContent ?? null; },
    async frame() { await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0))); },
    async click(selector) {
      const element = this.q(selector);
      if (!element) throw new Error('no ' + selector);
      const start = performance.now();
      element.click();
      await this.frame();
      return performance.now() - start;
    },
    async until(check, what) {
      const start = performance.now();
      while (!check()) {
        if (performance.now() - start > 5000) throw new Error('timed out waiting for ' + what);
        await this.frame();
      }
    },
    contains(selector, text) { return this.until(() => (this.text(selector) ?? '').includes(text), selector + ' to contain ' + JSON.stringify(text)); },
    exists(selector) { return this.until(() => !!this.q(selector), selector); },
    gone(selector) { return this.until(() => !this.q(selector), selector + ' to be gone'); },
    hasClass(selector, name) { return this.until(() => this.q(selector)?.classList.contains(name), selector + ' to have class ' + name); },
  };
`;
/** Each operation: init (unmeasured, with the benchmark's warmups) then the measured click and its check. */
const operations = [
  ['create rows', async (b) => {
    for (let i = 0; i < WARMUP; i++) { await b.click('#run'); await b.contains(row(1, 1), String(i * 1000 + 1)); await b.click('#clear'); await b.gone(row(1000, 1)); }
  }, async (b) => { const t = await b.click('#run'); await b.contains(row(1000, 1), String((WARMUP + 1) * 1000)); return t; }],
  ['replace all rows', async (b) => {
    for (let i = 0; i < WARMUP; i++) { await b.click('#run'); await b.contains(row(1, 1), String(i * 1000 + 1)); }
  }, async (b) => { const t = await b.click('#run'); await b.contains(row(1, 1), String(WARMUP * 1000 + 1)); return t; }],
  ['partial update', async (b) => {
    await b.click('#run'); await b.exists(row(1000, 1));
    for (let i = 0; i < 3; i++) { await b.click('#update'); await b.contains(`${row(991, 2)}>a`, ' !!!'.repeat(i + 1)); }
  }, async (b) => { const t = await b.click('#update'); await b.contains(`${row(991, 2)}>a`, ' !!!'.repeat(4)); return t; }],
  ['select row', async (b) => {
    await b.click('#run'); await b.contains(row(1000, 1), '1000');
    await b.click(`${row(5, 2)}>a`); await b.hasClass('tbody>tr:nth-of-type(5)', 'danger');
    if (b.all('tbody>tr.danger').length !== 1) throw new Error('more than one row selected');
  }, async (b) => { const t = await b.click(`${row(2, 2)}>a`); await b.hasClass('tbody>tr:nth-of-type(2)', 'danger'); return t; }],
  ['swap rows', async (b) => {
    await b.click('#run'); await b.exists(row(1000, 1));
    for (let i = 0; i <= WARMUP; i++) { await b.click('#swaprows'); await b.contains(row(999, 1), i % 2 === 0 ? '2' : '999'); }
  }, async (b) => {
    const t = await b.click('#swaprows');
    await b.contains(row(999, 1), WARMUP % 2 === 0 ? '999' : '2'); await b.contains(row(2, 1), WARMUP % 2 === 0 ? '2' : '999');
    return t;
  }],
  ['remove row', async (b) => {
    await b.click('#run'); await b.exists(row(1000, 1));
    for (let i = 0; i < WARMUP; i++) {
      const n = WARMUP - i + 4;
      await b.contains(row(n, 1), String(n)); await b.click(`${row(n, 3)}>a>span:nth-of-type(1)`); await b.contains(row(n, 1), String(4 + WARMUP + 1));
    }
  }, async (b) => { const t = await b.click(`${row(4, 3)}>a>span:nth-of-type(1)`); await b.contains(row(4, 1), String(4 + WARMUP + 1)); return t; }],
  ['create many rows', async (b) => {
    for (let i = 0; i < WARMUP; i++) { await b.click('#run'); await b.contains(row(1, 1), String(i * 1000 + 1)); await b.click('#clear'); await b.gone(row(1000, 1)); }
  }, async (b) => { const t = await b.click('#runlots'); await b.exists(`${row(10000, 2)}>a`); return t; }],
  ['append rows to large table', async (b) => {
    for (let i = 0; i < WARMUP; i++) { await b.click('#run'); await b.contains(row(1, 1), String(i * 1000 + 1)); await b.click('#clear'); await b.gone(row(1000, 1)); }
    await b.click('#run'); await b.exists(row(1000, 1));
  }, async (b) => { const t = await b.click('#add'); await b.exists(row(2000, 1)); return t; }],
  ['clear rows', async (b) => {
    for (let i = 0; i < WARMUP; i++) { await b.click('#run'); await b.contains(row(1, 1), String(i * 1000 + 1)); await b.click('#clear'); await b.gone(row(1000, 1)); }
    await b.click('#run'); await b.contains(row(1, 1), String(WARMUP * 1000 + 1));
  }, async (b) => { const t = await b.click('#clear'); await b.gone(row(1000, 1)); return t; }],
];

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

export async function runAll({ time = TIME, runs = RUNS } = {}) {
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const results = {};
  try {
    for (const { name } of implementations) {
      results[name] = {};
      for (const [label, init, measure] of operations) {
        const times = [];
        for (let run = 0; run < (time ? runs : 1); run++) {
          const page = await browser.newPage();
          const problems = [];
          page.on('pageerror', (error) => problems.push(error.message));
          page.on('console', (message) => message.type() === 'error' && !/Failed to load resource/.test(message.text()) && problems.push(message.text()));
          await page.goto(`${origin}/${name}/`);
          await page.evaluate(IN_PAGE);
          await page.waitForFunction(() => !!window.$bench.q('#run'));
          await page.evaluate(`(${init.toString()})(window.$bench)`);
          times.push(await page.evaluate(`(${measure.toString()})(window.$bench)`));
          if (problems.length) throw new Error(`${name}, ${label}: ${problems.join('; ')}`);
          await page.close();
        }
        results[name][label] = median(times);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await runAll();
  if (!TIME) {
    console.log(`Every operation passed the benchmark's checks: ${Object.keys(results).join(', ')}.`);
  } else {
    const names = Object.keys(results);
    console.log(`Median of ${RUNS} runs, ms from the click to the frame after it (Chromium, no throttling).\n`);
    console.log(`| Operation | ${names.join(' | ')} |`);
    console.log(`|---|${names.map(() => '---').join('|')}|`);
    for (const [label] of operations) console.log(`| ${label} | ${names.map((name) => results[name][label].toFixed(1)).join(' | ')} |`);
  }
}
