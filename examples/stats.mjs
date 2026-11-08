// The scoreboard from plan/roadmap-adoption.md: how much the example components say.
// `node examples/stats.mjs` prints the line count of every .mnx component in the examples and
// how often each workaround the 2.x sugar replaces still appears.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const all = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'build', 'ui', '_site'].includes(name) || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.mnx')) all.push(path);
  }
})(root);
// The browser apps' components (under src/), and the server and client apps' (2.6.2 on:
// helpdesk, backends, hypermedia, meta, extension, desktop).
const files = all.filter((path) => path.includes(`${'/'}src${'/'}`) && !/\/(extension|desktop)\//.test(path));
const later = all.filter((path) => /\/(helpdesk|backends|hypermedia|meta|extension|desktop)\//.test(path) && !files.includes(path));

const countIn = (list) => (pattern) => list.reduce((sum, file) => sum + (readFileSync(file, 'utf8').match(pattern)?.length ?? 0), 0);
const count = countIn(files);
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
  // 3.2: state updated immutably because mutation didn't react (`x = [...x, y]`, `x = x.filter(…)`).
  ['a let rebuilt instead of mutated', count(/\b(\w+) = (?:\[\.\.\.\1\b|\{ ?\.\.\.\1\b|\1\.(?:filter|map|concat|toSorted|toSpliced|with)\()/g)],
];
// The patterns 2.7's progressive enhancement replaces (plan/roadmap-server.md).
const counted = countIn(later);
const server = [
  ['components', later.length],
  ['lines', later.reduce((sum, file) => sum + readFileSync(file, 'utf8').split('\n').length - 1, 0)],
  ['"live" by hand (onMount sets a let)', counted(/onMount\(\(\) => \(live = true\)\)/g)],
  ['requestSubmit() by hand', counted(/requestSubmit\(\)/g)],
  ['selected={…} on options', counted(/<option[^>]*selected=\{/g)],
  ['.ctrl and .meta listener pairs', counted(/\.meta\.\w+[^>]*?=/g)],
  ['a child\'s model bound by hand', counted(/on\w+change=\{\(event\) => \(\w+ = event\.detail\)\}/g)],
  ['ref={…}', counted(/ref=\{/g)],
];
const width = Math.max(...[...rows, ...server].map(([name]) => name.length));
for (const [name, value] of rows) console.log(`${name.padEnd(width)}  ${value}`);
console.log('\nServer and client apps (helpdesk, backends, hypermedia, meta, extension, desktop):');
for (const [name, value] of server) console.log(`${name.padEnd(width)}  ${value}`);
