// docs/javascript-support.md against the server's tests: every built-in the page says the server
// evaluates has a case compared with V8 (server-evaluation.cases.js), and every built-in those
// cases call is on the page. So the page can't promise what isn't tested, or miss what is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAME } from './server-evaluation.cases.js';

const page = readFileSync(new URL('../../docs/javascript-support.md', import.meta.url), 'utf8');
const section = (heading) => {
  const start = page.indexOf(`\n### ${heading}\n`);
  assert.ok(start >= 0, `no "### ${heading}" in docs/javascript-support.md`);
  const end = page.indexOf('\n#', start + 1);
  return page.slice(start, end < 0 ? undefined : end);
};

// `.map`, `Math.round`, `Number()`, as the page writes them.
const listed = new Set([...section('Built-ins').matchAll(/`((?:\.|[A-Z][A-Za-z]*\.)?[A-Za-z]+)(?:\(\))?`/g)]
  .map((match) => match[1]));

// The same spellings, as the cases call them: `x.map(`, `Math.round(`, `Number(`, `parseInt(`.
const called = new Set(SAME.flatMap((expression) => [
  ...[...expression.matchAll(/\b(Math|Object|Number|Array|String)\.([A-Za-z]+)\(/g)].map((m) => `${m[1]}.${m[2]}`),
  ...[...expression.matchAll(/(?<![\w.])(Number|String|Boolean|parseInt|encodeURIComponent|encodeURI|decodeURIComponent|decodeURI)\(/g)].map((m) => m[1]),
  ...[...expression.replace(/\b(Math|Object|Number|Array|String)\.[A-Za-z]+\(/g, '')
    .matchAll(/[\w\])'"`]\.([a-z][A-Za-z]*)\(/g)].map((m) => `.${m[1]}`),
]));

test('every built-in the page lists has a case compared with V8', () => {
  const untested = [...listed].filter((name) => !called.has(name));
  assert.deepEqual(untested, [], 'listed in docs/javascript-support.md with no case in server-evaluation.cases.js');
});

test('every built-in the cases call is listed on the page', () => {
  const unlisted = [...called].filter((name) => !listed.has(name));
  assert.deepEqual(unlisted, [], 'called in server-evaluation.cases.js but missing from docs/javascript-support.md');
});
