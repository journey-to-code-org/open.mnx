// The scoreboard from plan/roadmap-adoption.md: how much the example components say.
// `node examples/stats.mjs` prints the line count of every .mnx component in the examples and
// how often each workaround the 2.x sugar replaces still appears.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.mnx') && path.includes(`${'/'}src${'/'}`)) files.push(path);
  }
})(root);

const count = (pattern) => files.reduce((sum, file) => sum + (readFileSync(file, 'utf8').match(pattern)?.length ?? 0), 0);
const lines = files.reduce((sum, file) => sum + readFileSync(file, 'utf8').split('\n').length - 1, 0);
const rows = [
  ['components', files.length],
  ['lines', lines],
  ["emit('<prop>change') by hand", count(/emit\(['"]\w+change['"]/g)],
  ['class={…} with a ternary or concatenation', count(/class=\{[^}]*(\?|\+)[^}]*\}/g)],
  ['event.preventDefault()', count(/preventDefault\(\)/g)],
  ['host() for querying', count(/host\(\)/g)],
  ['addEventListener on window/document', count(/(window|document)?\.?addEventListener\(/g)],
  ['.get() in templates and scripts', count(/\.get\(\)/g)],
];
const width = Math.max(...rows.map(([name]) => name.length));
for (const [name, value] of rows) console.log(`${name.padEnd(width)}  ${value}`);
