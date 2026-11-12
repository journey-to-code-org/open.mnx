// The server's evaluation of JavaScript beyond the build-time subset (src/pure.rs), against V8:
// every expression rendered into HTML by the compiler must read exactly as the browser would
// show it. Expressions outside the subset must be left for the browser, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.env.ZUBRA_COMPILER ??= join(here, '../../target/debug/zubra');
const { request } = await import('../index.js');
const { SCRIPT, SAME, LEFT } = await import('./server-evaluation.cases.js');

const component = (expression) => `<script>${SCRIPT}</script>\n<x-e>\n  <p>{${expression}}</p>\n</x-e>\n`;
const render = (expressions) => request({
  requests: expressions.map((expression) => ({
    emit: 'html', path: '/x.zb', files: { '/x.zb': component(expression) }, partial: true,
  })),
}).responses.map((response, index) => {
  assert.ok(response.ok, `${expressions[index]}: ${response.error}`);
  return /<p>([^]*?)<\/p>/.exec(response.output)?.[1];
});
const unescape = (html) => html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const inBrowser = (expression) => {
  const value = new Function(`${SCRIPT}; return (${expression});`)();
  return value == null ? '' : String(value);
};

test('expressions beyond the subset render on the server exactly as V8 shows them', () => {
  const html = render(SAME);
  const wrong = SAME.map((expression, index) => [expression, unescape(html[index] ?? ''), inBrowser(expression)])
    .filter(([, server, browser]) => server !== browser);
  assert.deepEqual(wrong, [], wrong.map(([expression, server, browser]) => `${expression}: server ${JSON.stringify(server)}, V8 ${JSON.stringify(browser)}`).join('\n'));
});

test('what isn\'t deterministic, isn\'t JSON or isn\'t in the subset is left for the browser', () => {
  const html = render(LEFT);
  const guessed = LEFT.filter((expression, index) => html[index] !== '');
  assert.deepEqual(guessed, []);
});
