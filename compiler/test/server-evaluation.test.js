// The server's evaluation of JavaScript beyond the build-time subset (src/pure.rs), against V8:
// every expression rendered into HTML by the compiler must read exactly as the browser would
// show it. Expressions outside the subset must be left for the browser, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.env.MNX_COMPILER ??= join(here, '../../target/debug/mnx');
const { request } = await import('../index.js');

const SCRIPT = `
  const rows = [{ label: "Kale", kg: 2.5, tags: ["leafy"] }, { label: "Beans", kg: 4, tags: [] }, { label: "Squash", kg: 9.25, tags: ["big", "orange"] }]
  const words = ["pear", "Apple", "fig", "banana"]
  const cents = 129905
  const text = "  Hello, world  "
  const empty = []
  const nothing = null
  const user = { name: "Ada", address: { city: "Paris" } }
  const money = (value) => "$" + (value / 100).toFixed(2)
  const total = rows.reduce((sum, row) => sum + row.kg, 0)
  const pct = (row) => {
    const share = row.kg / total
    return Math.round(share * 1000) / 10
  }
  const top = rows.toSorted((a, b) => b.kg - a.kg)[0]
`;

// Each reads the same in the server's HTML as in V8. (Not `==` between types: templates
// compile `==` to `===`, on the server and in the browser alike.)
const SAME = [
  'total', 'money(cents)', 'money(5)', 'money(-1999)', 'pct(rows[0])', 'top.label',
  'rows.map((row) => row.label).join(", ")', 'rows.filter((row) => row.kg > 3).length',
  'rows.some((row) => row.tags.includes("big"))', 'rows.every((row) => row.kg > 3)',
  'rows.find((row) => row.label.startsWith("B")).kg', 'rows.findIndex((row) => row.kg === 9.25)',
  'rows.map((row) => row.kg).toReversed().join("|")', 'rows.slice(-2).map((r) => r.label).join()',
  'rows.at(-1).label', 'words.toSorted().join()',
  'words.indexOf("fig")', 'words.includes("kiwi")', 'words.concat(["kiwi"], "plum").length',
  '`${user.name} lives in ${user.address.city}`', 'user?.address?.city', 'nothing ?? "none"',
  'text.trim()', 'text.trimStart().length', 'text.trim().toUpperCase()', 'text.trim().toLowerCase()',
  'text.trim().slice(0, 5)', 'text.trim().slice(-6, -1)', 'text.trim().substring(7, 2)', 'text.indexOf("world")',
  'text.trim().split(", ").join(" / ")', 'text.trim().replace("l", "L")', 'text.trim().replaceAll("l", "L")',
  'String(7).padStart(3, "0")', '"ab".padEnd(5, "xy")', '"na".repeat(3)', 'text.trim().at(-1)', 'text.trim().charAt(4)',
  'Math.round(2.5)', 'Math.round(-2.5)', 'Math.round(-0.4)', 'Math.floor(-1.5)', 'Math.ceil(1.2)', 'Math.trunc(-4.7)',
  'Math.abs(-3)', 'Math.sign(-0.5)', 'Math.min(3, 1, 2)', 'Math.max(3, 1, 2)', 'Math.sqrt(2)',
  '(1.005).toFixed(2)', '(2.5).toFixed(0)', '(-1.5).toFixed(0)', '(0.000001234).toFixed(8)', '(123.456).toFixed(1)',
  '(1e21).toFixed(2)', '0.1 + 0.2', '1 / 3', '2 ** 10 > 1000 ? "big" : "small"', '7 % 3', '-7 % 3',
  'Number("42") + 1', 'Number("") + 1', 'Number(true)', 'String(null) + String(false)', 'parseInt("12px")',
  '"5" === 5', 'null == undefined', 'typeof money', 'typeof nothing', 'typeof rows', '!empty.length',
  'Object.keys(user).join()', 'Object.entries({ a: 1, b: 2 }).map((entry) => entry[0] + entry[1]).join()',
  'Array.isArray(rows)', 'Number.isInteger(4.0)', '[...words, "kiwi"].length', '({ ...user, name: "Grace" }).name',
  'rows.reduce((best, row) => (row.kg > best.kg ? row : best)).label', 'empty.join("-") === ""',
  '((x) => (y) => x + y)(2)(3)', '[3, 1, 2].toSorted((a, b) => a - b).join()', '"b" < "a"', '10 < 9',
];

// Left for the browser (not deterministic everywhere, not JSON, or not in the subset).
const LEFT = [
  'Math.random()', 'Date.now()', 'new Date().getFullYear()', 'cents.toLocaleString()',
  'new Intl.NumberFormat("en").format(cents)', 'Math.abs(1) / 0', 'Math.sqrt(-1)', 'rows.map(function (row) { return row.kg })',
  'window.innerWidth + Math.abs(0)', 'rows.sort().length', 'Object.entries(user).map(([key]) => key).join()', 'words.map((word, i, all) => all.length).join()',
];

const component = (expression) => `<script>${SCRIPT}</script>\n<x-e>\n  <p>{${expression}}</p>\n</x-e>\n`;
const render = (expressions) => request({
  requests: expressions.map((expression) => ({
    emit: 'html', path: '/x.mnx', files: { '/x.mnx': component(expression) }, partial: true,
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
