// The expressions the server evaluates (SAME) and leaves for the browser (LEFT), and the script they
// read. server-evaluation.test.js compares each with V8; javascript-support.test.js checks that
// docs/javascript-support.md lists exactly the built-ins tested here.
export const SCRIPT = `
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
  const server = "https://cards.example.com/"
  const trimmed = server.replace(/\\/+$/, "")
  const castle = "🏰 Palace 🏰"
  const query = "game=palace&who=Grammi Nichols"
  const dated = "2026-11-13".replace(/(?<y>\\d+)-(?<m>\\d+)-(?<d>\\d+)/, "$<d>/$<m>/$<y> $<nope>.")
`;

// Each reads the same in the server's HTML as in V8. (Not `==` between types: templates
// compile `==` to `===`, on the server and in the browser alike.)
export const SAME = [
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
  // ES2019–ES2024 additions (plan: roadmap-ecmascript E1).
  'rows.findLast((row) => row.kg < 5).label', 'rows.findLastIndex((row) => row.tags.length > 0)',
  'rows.findLast((row) => row.kg > 99) ?? "none"', 'rows.findLastIndex((row) => row.kg > 99)',
  'words.with(-1, "kiwi").join()', 'words.with(0, "kiwi").join()',
  'words.toSpliced(1, 2, "kiwi", "plum").join()', 'words.toSpliced(-1).join()', 'words.toSpliced(1).join()',
  'words.toSpliced().join()', 'words.toSpliced(2, 0, "kiwi").join()', 'words.toSpliced(1, -3).join()',
  '[1, [2, [3, [4]]]].flat().length', '[1, [2, [3, [4]]]].flat(2).length', '[1, [2]].flat(0).length',
  'rows.flatMap((row) => row.tags).join()', 'rows.flatMap((row) => (row.kg > 3 ? [row.label, row.kg] : [])).join()',
  'rows.flatMap((row) => [[row.label]]).length',
  'Object.keys(Object.fromEntries(rows.map((row) => [row.label, row.kg]))).join()',
  'Object.fromEntries([["b", 1], ["2", 2], ["a", 3], ["1", 4], ["b", 5]]).b',
  'Object.keys(Object.fromEntries([["b", 1], ["2", 2], ["a", 3], ["1", 4], ["b", 5]])).join()',
  'Object.keys(Object.groupBy(rows, (row) => (row.kg > 3 ? "heavy" : "light"))).join()',
  'Object.groupBy(rows, (row) => (row.kg > 3 ? "heavy" : "light")).heavy.map((row) => row.label).join()',
  'Object.keys(Object.groupBy(words, (word) => word.length)).join()',
  'Object.groupBy(words, (word, i) => i % 2)[1].join()',
  'Object.hasOwn(user, "name")', 'Object.hasOwn(user, "toString")', 'Object.hasOwn(words, 3)',
  'Object.hasOwn(words, 4)', 'Object.hasOwn(words, "length")', 'Object.hasOwn(text, 0)',
  'Object.keys({ b: 1, 2: 2, a: 3, 1: 4 }).join()', 'words.toSpliced(2, 99, "kiwi").join()',
  'Object.keys(Object.fromEntries([["b", 1], ["4294967295", 2], ["4294967294", 3]])).join()',
  'words.lastIndexOf("fig")', 'text.trim().endsWith("world")', 'text.trimEnd().length', 'Object.values(user).length',
  'Boolean("")', 'Boolean(cents)'
];

// Left for the browser (not deterministic everywhere, not JSON, or not in the subset).
// Regular expression literals, matched on UTF-16 code units as V8 does.
SAME.push(
  'trimmed', '"a-b_c".replace(/[-_]/g, " ")', '"a-b_c".replace(/[-_]/, " ")', '"aaa".replace(/a*/g, "x")', '"abc".replace(/x*/g, "-")',
  '"John Smith".replace(/(\\w+)\\s(\\w+)/, "$2, $1")', '"abc".replace(/b/, "[$&|$`|$\'|$$|$0|$3]")', '"abc".replace(/(b)/, "$01$10$1x")',
  'dated', '"a1b22c333".replace(/\\d+/g, (digits) => digits.length)',
  '"x-y".replace(/(\\w)-(\\w)/, (all, a, b, at, whole) => `${b}${a}@${at}/${whole}`)', '"Ada Lovelace".replaceAll(/[aeiou]/gi, "*")',
  '"a, b,c ,d".split(/\\s*,\\s*/).join("|")', '"a1b2c3".split(/(\\d)/).join("|")', '"a1b2c3".split(/\\d/, 2).join("|")', '"abc".split(/(?:)/).join("|")', '"".split(/x/).length', '"".split(/(?:)/).length',
  '"Hello World".match(/o/g).join()', '"Hello".match(/z/g) === null', '"Hello World".search(/World/)', '"Hello".search(/z/)',
  '/^p/i.test("Palace")', '/^\\d+$/.test("12a")', 'castle.replace(/./g, "x")', 'castle.replace(/./gu, "x")', 'castle.split(/\\s/).length', 'castle.search(/P/)',
  '"ÉCOLE".replace(/é/i, "e")', '"line1\\nline2".replace(/^line/gm, "L")', '"a\\nb".replace(/a.b/s, "ok")', '"tab\\tx".replace(/\\s/, "_")',
  '"aab".replace(/(?<=a)b/, "B")', '"price: 12".replace(/(?!price)\\d+/, "N")', '"ab".replace(/(x)?b/, "[$1]")',
);
// URI encoding.
SAME.push(
  'encodeURIComponent(query)', 'encodeURI("https://x.example/a b?c=d&e=é#f")', 'encodeURIComponent("-_.!~*\'()🏰 ")',
  'decodeURIComponent("game%3Dpalace%20%F0%9F%8F%B0")', 'decodeURI("%3Fa%3D1%20b%23c%2F%41")', 'decodeURIComponent(encodeURIComponent(castle))',
  '`${trimmed}/?game=${encodeURIComponent("palace & spades")}`',
);

export const LEFT = [
  'Math.random()', 'Date.now()', 'new Date().getFullYear()', 'cents.toLocaleString()',
  'new Intl.NumberFormat("en").format(cents)', 'Math.abs(1) / 0', 'Math.sqrt(-1)', 'rows.map(function (row) { return row.kg })',
  'window.innerWidth + Math.abs(0)', 'rows.sort().length', 'Object.entries(user).map(([key]) => key).join()', 'words.map((word, i, all) => all.length).join()',
  'words.with(9, "kiwi").join()', 'Object.fromEntries([["a"]]).a', 'Object.hasOwn(nothing, "a")',
  '[1, [2, [3]]].flat(Infinity).length', 'Object.fromEntries([["a"]]).a === undefined', 'Object.keys({ a: undefined, b: 1 }).join()', 'rows.flatMap((row) => row.tags, null).length + Math.random()',
  // Stateful (lastIndex, sticky), not JSON (a non-global match's array, an unmatched split group), or
  // what the browser throws on.
  '/a/g.test("a")', '"aaa".replace(/a/y, "b")', '"abc".match(/b/).index', '"abc".match(/b/)[0]', '"ab".split(/(x)?b/).length',
  '"abc".replaceAll(/b/, "x")', 'String(/a/)', '/a/', 'decodeURIComponent("%E0%A4%A")', 'decodeURIComponent("%C0%80")', 'decodeURIComponent("%")',
  // Patterns that could take exponential time, and text too long for a pattern's repeats.
  '"aaaa".replace(/(a+)+b/, "x")', '"aaaa".replace(/(a|a)*b/, "x")', '"abab".replace(/(ab)\\1/, "x")', '"x".repeat(5000).replace(/x*y*z*$/, "done").length',
];
