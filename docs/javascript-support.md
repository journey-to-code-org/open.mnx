# What JavaScript runs where

A `.zb` component's JavaScript passes through three places, and each has its own answer to "does this work?":

| | What it does with your JavaScript | So a feature works if… |
|---|---|---|
| **The compiler** | Parses the `<script>` and every `{expr}` with oxc (TypeScript too, with `lang="ts"`), checks them, and writes them into the element's module unchanged. It doesn't transpile or polyfill. | oxc parses it: any finished ECMAScript feature does. |
| **The browser** | Runs the element's module as written. | Your users' browsers run it. Zubra's own runtime targets Baseline 2026 ([Browser support](browser-support.md)); what your code needs is up to you and your bundler. |
| **The server** | Evaluates a deterministic subset of expressions in Rust, so the HTML is complete before JavaScript. Everything outside it is left for the element to fill in when it starts. | It's in the tables below. |

Zubra's own APIs follow the same rule as the runtime: a newer feature is used where the browser has it, and nothing depends on it. For example, `effect()`, `scope()` and `resource()` are disposables, so `using stop = effect(…)` works in browsers with Explicit Resource Management (Chrome 134+, Firefox 141+; not Safari yet), and elsewhere they're disposed as always.

The rest of this page is about the server, because that's the only place where Zubra decides. It's the same evaluator in the Rust CLI, the WebAssembly build and every server package, so Flask, Node and Axum render the same HTML.

## On the server

The rule: only what gives the same answer on every platform, compared against V8 by `compiler/test/server-evaluation.test.js`. Every built-in in these tables has a case in that test, and a test checks this page against it, so the page can't drift from what's tested.

### Syntax

Literals, arrays and objects (with spread), member and index access (with `?.`), arithmetic and `**`, comparisons (`==` and `!=` compile to strict), `!`, `&&`, `||`, `??`, `? :` with JavaScript's truthiness, `typeof`, template literals, regular expression literals (below), and functions: the script's own arrow functions (`const money = (cents) => …`) and `function` declarations, callbacks, and function expressions.

### Statements in a function

A function's body can be statements, not just an expression:

- `const` and `let`, scoped to their block;
- assignment (`=`, `+=` and the other arithmetic forms, `||=`, `&&=`, `??=`) and `++`/`--` to the function's own parameters and `let`s;
- `.push(…)` onto the function's own arrays;
- `if`/`else`, `for`, `for…of` (over an array or a string, by code point) and `while`, with `break` and `continue`;
- `return`.

```js
function around(current, total) {
  const list = []
  for (let n = 1; n <= total; n++) {
    if (n === 1 || n === total || Math.abs(n - current) <= 1) list.push(n)
    else if (list[list.length - 1] !== 'gap') list.push('gap')
  }
  return list
}
```

A function that changes anything outside itself (the component's state, an object's property), or calls something for its effect (`list.sort()`, `console.log`), is left for the browser. So is one that doesn't finish within the step limit.

### Built-ins

| Kind | Evaluated on the server |
|---|---|
| Array methods | `.at`, `.concat`, `.every`, `.filter`, `.find`, `.findIndex`, `.findLast`, `.findLastIndex`, `.flat`, `.flatMap`, `.includes`, `.indexOf`, `.join`, `.lastIndexOf`, `.map`, `.reduce`, `.slice`, `.some`, `.toReversed`, `.toSorted`, `.toSpliced`, `.with` |
| String methods | `.at`, `.charAt`, `.endsWith`, `.includes`, `.indexOf`, `.match`, `.padEnd`, `.padStart`, `.repeat`, `.replace`, `.replaceAll`, `.search`, `.slice`, `.split`, `.startsWith`, `.substring`, `.toLowerCase`, `.toUpperCase`, `.trim`, `.trimEnd`, `.trimStart` |
| Regular expressions | `.test` |
| Number methods | `.toFixed` |
| Math | `Math.abs`, `Math.ceil`, `Math.floor`, `Math.max`, `Math.min`, `Math.round`, `Math.sign`, `Math.sqrt`, `Math.trunc` |
| Object | `Object.entries`, `Object.fromEntries`, `Object.groupBy`, `Object.hasOwn`, `Object.keys`, `Object.values` |
| Others | `Array.from` (an array, a string by code point, or `{ length }` with a mapper), `Array.isArray`, `Number.isInteger`, `Boolean()`, `Number()`, `String()` (also as callbacks: `.map(String)`, `.filter(Boolean)`), `parseInt()`, `encodeURIComponent()`, `encodeURI()`, `decodeURIComponent()`, `decodeURI()` |

Regular expression literals (`/\/+$/`, `/(?<y>\d+)-(?<m>\d+)/gi`) run on an ECMAScript regex engine that matches on UTF-16 code units, as the browser does: without the `/u` flag, `/./` takes half of an emoji, and with it the whole emoji. They work with `.replace` and `.replaceAll` (with `$&`, `` $` ``, `$'`, `$1`–`$99`, `$<name>` and `$$` in the replacement, or an arrow function), `.split` (with a limit, and capturing groups in the result), `.match` with `/g`, `.search` and `.test` without `/g`.

A backtracking regex engine can take exponential time on some patterns, and a build must never hang on a component. So the server reads a pattern before running it: a repeated part that holds another repeat or a `|` (the shape of `(a+)+` or `(a|b)*`) and backreferences are left for the browser, and the text a pattern searches is limited by how many repeats it has (10,000 characters for one, a few hundred for two, fewer for more).

Objects keep JavaScript's key order: index-like keys first, ascending, then the rest as written, so `Object.keys({ b: 1, 2: 2 })` is `2,b` on the server as in the browser.

### Left for the browser, on purpose

| What | Why |
|---|---|
| `Date.now()`, `new Date()`, `Intl`, `.toLocaleString()`, `Math.random()` | Not the same answer on the server and in the browser (clock, time zone, locale, chance). Pass the value as a prop if the server should render it. |
| `window`, `document`, `navigator` | They exist only in the browser. |
| `.sort()`, `.splice()`, `.reverse()` and other mutating methods | A template expression shouldn't change state. `.toSorted()`, `.toSpliced()` and `.toReversed()` do the same without mutating, and render on the server. |
| Destructured parameters and defaults, a callback's third argument, `async` functions and generators, `this` | Outside the subset. |
| `Map`, `Set`, iterators and iterator helpers, `BigInt`, `Map.groupBy` | The server's values are JSON, and these aren't. |
| Infinity, NaN, `undefined` inside an object, `.flat(Infinity)` | Not JSON either. |
| What the browser would throw on: `.with()` out of range, `Object.hasOwn(null, …)`, `decodeURIComponent("%")`, `.replaceAll()` with a regex without `/g` | The browser reports the error, where you'll see it. |
| Regex state and regex objects: `lastIndex`, the `/y` flag, `.test` with `/g`, a `.match` without `/g` (its array carries `index` and `groups`), `.exec`, `.matchAll`, `new RegExp()`, printing a regex | Their answers depend on state, or aren't JSON. |
| Regex patterns that could take exponential time (`(a+)+`, `(a|b)*`, backreferences), and text longer than a pattern's limit | So a build never waits on a pattern. The browser runs them as it always would. |

`zubra check --server` lists every place a component leaves for the browser. It's an error when the place is `checked`, `selected`, `value` or `disabled`, because without JavaScript the form would show and submit the wrong thing. [Server rendering, honestly](server-rendering.md) explains what renders where.

## Not yet

These are on the radar, not promised:
- **`Map`, `Set` and iterator helpers on the server**, which need a value the server can serialize into the page.
- **Temporal** stays browser-only for the same reason `Date` does. Rendering dates on the server would need an explicit clock and time zone, passed in by the app.
- **Reactive reads after `await`** in `resource()`, through AsyncContext or the compiler ([Signals report](standards/signals.md)).
