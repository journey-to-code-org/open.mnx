// How long the compiler takes to render the comparison's server page components
// (docs/compared/coexist: a table, a form field, a quantity control), in the WebAssembly build
// users get, as `@zubra/server` asks for them.
//
//   node benchmarks/server-render.mjs [--renders 2000] [--against <another zubra.wasm>]
//
// With `--against` (a released build, say: `npm pack @zubra/compiler@5.14.0` and its
// zubra.wasm), both are timed in the same process, in alternating batches, and compared: the
// machine's noise is then in both. Each figure is the median of 9 batches.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createCompiler } from '../compiler/core.js';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const RENDERS = Number(option('--renders', 2000));
const BATCHES = 9;
const here = fileURLToPath(new URL('..', import.meta.url));
const compiler = (path) => createCompiler(new WebAssembly.Module(readFileSync(path)));
const built = compiler(`${here}compiler/zubra.wasm`);
const other = args.includes('--against') ? compiler(option('--against')) : null;

const dir = `${here}docs/compared/coexist/impl/zubra/components`;
const files = Object.fromEntries(['ds-table', 'ds-badge', 'ds-field', 'ds-quantity'].map((name) => [`${dir}/${name}.zb`, readFileSync(`${dir}/${name}.zb`, 'utf8')]));
const columns = [
  { key: 'id', label: 'Order' },
  { key: 'customer', label: 'Customer', sortable: true },
  { key: 'quantity', label: 'Mugs' },
  { key: 'total', label: 'Total', type: 'money', sortable: true },
  { key: 'status', label: 'Status', type: 'status' },
];
const orders = (count) => Array.from({ length: count }, (_, i) => ({ id: 1001 + i, customer: `Customer ${i}`, quantity: (i % 10) + 1, total: ((i % 10) + 1) * 12.5, status: ['pending', 'shipped', 'cancelled'][i % 3] }));
const ask = (name, props) => ({ path: `${dir}/${name}.zb`, files, emit: 'html', props, slots: {}, slotSource: 'html', partial: true });
const CASES = [
  ['table, 3 orders', ask('ds-table', { caption: 'Orders', columns, rows: orders(3) }), 1],
  ['table, 100 orders', ask('ds-table', { caption: 'Orders', columns, rows: orders(100) }), 10],
  ['field', ask('ds-field', { label: 'Customer', name: 'customer', required: true, error: '' }), 1],
  ['quantity', ask('ds-quantity', { label: 'Quantity', name: 'quantity', min: 1, max: 10 }), 1],
];

const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
function batch(zubra, body, count) {
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const response = zubra.request(body);
    if (!response.ok) throw new Error(response.error);
  }
  return ((performance.now() - started) / count) * 1000;
}

console.log(`| Render | ${other ? 'other | built | built / other' : 'built'} |\n|---|${other ? '---:|---:|---:' : '---:'}|`);
for (const [name, body, slower] of CASES) {
  const count = Math.max(10, Math.round(RENDERS / BATCHES / slower));
  // (Said, not refused: a release may change the HTML on purpose.)
  if (other && other.request(body).output !== built.request(body).output) console.log(`(${name}: the two builds render different HTML)`);
  for (const zubra of other ? [other, built] : [built]) batch(zubra, body, count); // warm
  const times = { built: [], other: [] };
  for (let i = 0; i < BATCHES; i++) {
    if (other) times.other.push(batch(other, body, count));
    times.built.push(batch(built, body, count));
  }
  const b = median(times.built);
  console.log(other ? `| ${name} | ${Math.round(median(times.other))} µs | ${Math.round(b)} µs | ${(b / median(times.other)).toFixed(2)} |` : `| ${name} | ${Math.round(b)} µs |`);
}
