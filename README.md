<p align="center"><img src="brand/zubra-tile.svg" width="96" height="96" alt="Zubra"></p>

# Zubra

Zubra is a compiler for Web Components. You write a component as HTML with `{expr}` bindings and a `<script>`. Zubra turns it into server-rendered HTML and a small custom element that hydrates that HTML. React, Vue and any other framework can then use the element without integration code.

The runtime is built on what the web platform is standardizing: the TC39 Signals API, template parts in the shape of DOM Parts, the Context Protocol, form-associated custom elements and declarative shadow DOM. The aim is for the platform to absorb what Zubra proves, so the runtime shrinks as native features ship. See `runtime/README.md`.

**Nothing is hidden.** `zubra compile` prints the HTML and the JavaScript module it generates, and every part of them exists because of a rule of the platform. Reading the output is the quickest way to learn how Web Components work: [Read the output](docs/guide/08-read-the-output.md) goes through one component's real output and the nine rules behind it (names, constructors, attributes, upgrades, lifecycle, events, shadow DOM, forms, server HTML).

**Start here:** `npm create zubra@latest` writes a working app for your framework (or none), with a dev server that updates components in place. The [playground](https://journey-to-code-org.github.io/zubra/playground/) runs Zubra in your browser, the [demo gallery](https://journey-to-code-org.github.io/zubra/) has a live app for every framework, and [the guide](docs/guide/README.md) is a tutorial, with pages for React, Vue and Svelte developers. The same pages, with this README as the reference, are [the documentation site](https://journey-to-code-org.github.io/zubra/docs/).

**Status: 5.x.** The major version counts breaking changes to the `.zb` format, the CLI and the runtime's public API, not years in use: 4.0 was the rename from the project's working name, 5.0 moved the hydration markers to processing instructions. Within 5.x all three are stable, with no breaking changes before 6.0. See `CHANGELOG.md`, and [Compared with Lit and Stencil](docs/compared-with-lit-and-stencil.md) for where Zubra stands against the two toolchains most teams already use.

**What Zubra is, and what it isn't.** Zubra is the compiler and its runtime: `.zb` in, elements, server HTML, typings and framework wrappers out. Everything else in this repository is optional and separate, and nothing in the compiler needs it:

| Package | What it adds | Needed when |
|---|---|---|
| `@zubra/unplugin` | `.zb` imports in Vite, Rollup, webpack, esbuild, Rspack; React and Vue wrappers; Astro | Your app has a bundler |
| `@zubra/server` | Components in Express, Fastify, Hono or any template engine; the SSR bridge for meta-frameworks | A JavaScript server renders pages |
| `@zubra/actions` | `'use server'` functions over plain form POST | A component owns a form endpoint |
| `@zubra/sync` | `'use collection'`: state kept in IndexedDB, synced across tabs and devices | A component's state must survive reloads or work offline |
| `create-zubra`, the VS Code extension, the registry | A starter, editor support, 26 components to copy | Convenience |

Each sibling exists because a component feature wanted it (`docs/actions.md`, `docs/sync.md` say which), and each is a separate install that the compiler reports by name when a component uses a directive it serves. The compiler knows those two directives itself rather than through a plugin hook, so that the CLI, `zubra serve` and servers in other languages compile a `.zb` file exactly as a bundler does; [Compared with Lit and Stencil](docs/compared-with-lit-and-stencil.md#why-the-compiler-knows-use-server-and-use-collection-by-name) has the reasoning. A compiler alone, with `zubra compile --emit element`, is one file and no dependency.

```html
<!-- copy-button.zb -->
<script>
  let copied = false                               // state: assigning it updates the DOM

  async function copy() {
    await navigator.clipboard.writeText(text)      // `text` is a prop, by name
    copied = true
    setTimeout(() => (copied = false), 1500)
  }
</script>
<style>
  button.done { color: green; }                    /* scoped to this component, in light DOM */
</style>
<copy-button text label="Copy">                    <!-- the host tag: the element and its props -->
  <button type="button" onclick={copy} class:done={copied}>
    {copied ? "Copied!" : label}
  </button>
</copy-button>
```

```sh
zubra compile copy-button.zb --props props.json   # the HTML a server sends (whitespace aside), for {"text":"npm create zubra"}:
#   <copy-button text="npm create zubra"><button type="button">Copy</button></copy-button>
zubra compile copy-button.zb --emit js             # the custom element that hydrates it
```

```html
<copy-button text="npm create zubra"></copy-button>      <!-- plain HTML -->
```
```tsx
<CopyButton text="npm create zubra" />                   // React or Vue, through @zubra/unplugin: same file, typed
```

<details>
<summary>The same element written by hand (about 45 lines)</summary>

```js
const template = document.createElement("template");
template.innerHTML = `<style>button.done { color: green; }</style><button type="button"></button>`;

class CopyButton extends HTMLElement {
  static observedAttributes = ["text", "label"];
  #copied = false;
  #timer = null;
  #button;
  #onClick = () => this.copy();              // a stored reference, so removeEventListener works

  constructor() {
    super();
    this.attachShadow({ mode: "open" }).append(template.content.cloneNode(true));
    this.#button = this.shadowRoot.querySelector("button");
  }
  get text() { return this.getAttribute("text") ?? ""; }
  set text(v) { this.setAttribute("text", v); }
  get label() { return this.getAttribute("label") ?? "Copy"; }
  set label(v) { this.setAttribute("label", v); }

  connectedCallback() {
    this.#button.addEventListener("click", this.#onClick);
    this.#render();
  }
  disconnectedCallback() {
    this.#button.removeEventListener("click", this.#onClick);
    clearTimeout(this.#timer);
  }
  attributeChangedCallback() { this.#render(); }

  async copy() {
    await navigator.clipboard.writeText(this.text);
    this.#copied = true;
    this.#render();                           // every state change has to remember this
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#copied = false; this.#render(); }, 1500);
  }
  #render() {
    this.#button.textContent = this.#copied ? "Copied!" : this.label;
    this.#button.classList.toggle("done", this.#copied);
  }
}
customElements.define("copy-button", CopyButton);
```

It needs shadow DOM to scope one style rule, has no server HTML, and has to avoid by hand the two bugs most hand-written elements have (a forgotten `#render()`, a listener removed with a different reference). The compiler writes all of it.
</details>

The by-hand version is the platform's own API with nothing in the way. The compiled output is the same behaviour in two pieces: a short description of this component (the module `--emit js` prints) and one class every component shares (`defineElement` in `runtime/src/element.js`). [Read the output](docs/guide/08-read-the-output.md) maps each rule in the by-hand version to where Zubra handles it.

The reactivity is the point, not a feature. `let` is state, and the template is bound to it:

```html
<script>
  let count = 0
</script>
<click-counter>
  <button onclick={() => count++}>Clicked {count} times</button>
</click-counter>
```

Nothing re-renders: `count++` updates one text node. The script runs once per element, the way Solid and Svelte 5 work, on the TC39 Signals API.

**Who it's for.** One component with more than one consumer: a component library or design system used from more than one framework, components handed to other people's stacks, anything that has to live in a CMS, an older app or a static site, and servers that aren't JavaScript. If one app on one framework is the only consumer, you don't need it; [Who Zubra is for](docs/who-this-is-for.md) says why, and [What crosses the boundary](docs/what-crosses-the-boundary.md) says which components fit through an element and which belong in the framework. Astro lets frameworks coexist on a page; Zubra lets one component be used by all of them. If you're weighing it against Lit or Stencil, [Compared with Lit and Stencil](docs/compared-with-lit-and-stencil.md) says where each is the better choice.

## Writing a component

- **The host tag declares the component.** Its name is the custom element. Its attributes are the props: `title={titleDefault}` declares a prop whose default comes from the script, `label="Hi"` a string default, and a bare `name` a required prop. Kebab-case attributes become camelCase props (`max-value` → `maxValue`). The default's type is the prop's type. `shadow` opts into shadow DOM (light DOM is the default) and `form-associated` makes the element a form control. A comment above the component becomes its description in the generated docs and types.
- **The host is the root**: the template can have any number of top-level nodes.
- **Defaults computed in the browser.** A prop whose default uses a value the server can't compute (`since={start}` with `const start = Date.now()`, or anything reading `window`, `document`, `Intl`, `Math.random()` or a `function` declared in the script) gets it per element, after the script runs, unless the prop was given by an attribute or property. The HTML output needs that prop from `--props` (or from the parent), and says so.
- **`<script>` is real JavaScript** (parsed with oxc), run once per element. Top-level `const`/`let` initializers that the server can evaluate (see What the server can render: props, other such bindings, arrow functions defined in the script, the deterministic built-ins) are also evaluated at build time for the HTML output. A top-level `let` is state, and props are names (see Script, state and hooks). Using a runtime-only value in static HTML is a compile error that says so (or, with `--partial`, left for the element).
- **`<script lang="ts">`** is TypeScript, reduced to JavaScript by removing its types in place, so every line and column stays where it was and errors point into your source. Only erasable syntax is accepted, as with Node's type stripping or TypeScript's `erasableSyntaxOnly`. `enum`, `namespace`, parameter properties, `<T>x` assertions and `import x = require()` are errors that say what to write instead ([TypeScript in `.zb` files](docs/typescript.md) has the whole rule and what it costs). The types aren't lost: a prop whose default is an annotated binding (`const options: Option[] = …`, then `options={options}`) has that type, `emit<Picked>("pick", …)` types the event's `detail`, and the script's `type`/`interface` declarations are exported from the generated typings.
- **`{expr}`** works in text, in quoted attributes (`class="card {kind}"`, always a string) and as a whole attribute value (`data={value}`, any type). Any JavaScript expression works, and the HTML output evaluates the ones whose answer is the same everywhere: literals, arrays and objects, member and index access (with `?.`), arithmetic, comparisons (`==`/`!=` are strict), `&&` `||` `??` and `? :` with JavaScript's truthiness, template literals, arrow functions defined in the script and arrow callbacks (`{items.filter((item) => item.done).length}`), and the deterministic built-ins in What the server can render. Signals read in the template (`{count}`) are reactive.
- **The rest runs in the browser only**: a `function` declared in the script (`{format(price)}`; write `const format = (…) => …` to render it on the server), `new`, `Date`, `Intl`, `Math.random()`, `toLocaleString()`, `window`, `document`, and anything else outside that subset. Names mean what they mean in the script: a signal `const` reads as its value (`{count * 2}`), and props and list items read as they do anywhere else. A template can assign to props only (`onclick={() => { open = !open }}`), and `emit()` in a template declares its event like one in the script. Without `--partial`, the HTML output reports a browser-only part it would have to render as an error, and `zubra check --server` lists them all. Handlers are never rendered, so inline handlers like `onclick={() => remove(item.id)}` don't count.
- **Names resolve** to loop variables, then props, then script bindings. Every reference is checked in every branch, including branches a build won't render, and unknown names get a "did you mean" suggestion. Errors point at the source line with a caret.
- **Events from the template**: `onclick={increment}` calls a script function, read when the event fires; `onclick={() => rate(2)}` works too.
- **Warnings** flag props that shadow built-in element properties (a `hidden` prop also hides the element; `title` also shows a tooltip).

## JSX components

A component can also be a function in a `.zb.jsx` or `.zb.tsx` file. It compiles to the same element as a `.zb` file, and the two formats import each other.

```jsx
// rating.zb.jsx
/** A two-star rating. */
export default function ZbRating({ value = 0, onValueChange }) {
  let hovered = null                         // state: assigning it updates the DOM
  const shown = hovered ?? value             // derived from props and state: stays in sync
  function rate(stars) {
    value = stars                            // props are names, readable and writable
    onValueChange(stars)                     // fires `valuechange` with detail `stars`
  }
  return (
    <>
      {[1, 2].map((star) => (
        <button key={star} onClick={() => rate(star)} onMouseEnter={() => (hovered = star)}>{star}</button>
      ))}
      <output>{shown}</output>
      {value > 1 && <em>Great!</em>}
    </>
  )
}
```

- **The function's name is the tag**: `ZbRating` is `<zb-rating>` (custom elements need a hyphen, so `Rating` is an error). Return the host itself (`<zb-rating shadow>…</zb-rating>`) to set `shadow` or `form-associated`.
- **Destructured parameters are props**, with their defaults; one without a default is required. **`on<Name>` parameters are events**: calling `onValueChange(x)` fires `valuechange` with `detail: x`, so React users pass `onValueChange` and everyone else listens for `valuechange`. **`children`** is the default slot; `<zb-slot name="…">` declares named ones.
- **The body runs once per element**, not on every change. A top-level `let` is state, a top-level `const` that reads props or state is derived, and everything in the returned JSX is a fine-grained binding.
- **In the JSX**: `cond && <X/>` and `cond ? <A/> : <B/>` are conditionals, `list.map((item, i) => <li key={item.id}>…</li>)` is a keyed list, imported components are used by name (`import Badge from './badge.zb'`, then `<Badge label="x" />`), and `className`, `htmlFor` and `onClick` mean `class`, `for` and `onclick`. Any JavaScript expression works, as in `.zb` templates.
- Errors point into the JSX. Not supported yet, each with an error that says what to do instead: spread props and attributes, `ref`, render props (JSX in attributes), renamed or nested destructured props, early returns, and module-level `let`. Prop types come from defaults, and JSX components have no `<style>` yet.

`plan/decisions/jsx-components.md` in the project docs records the design.

## Directives

- `<zb-if test={…}>`, with `<zb-else-if test={…}>` and an optional final `<zb-else>` inside it. For one element, the condition can be an attribute: `<p zb-if={…}>`, with `zb-else-if={…}` and `zb-else` on the siblings right after it. Both forms compile to the same thing. The `zb-` attribute prefix is reserved: any other `zb-` attribute is an error.
- **Markup in braces**, in the three forms that are directives: `{a && <p>…</p>}` is a `zb-if`, `{a ? <b>…</b> : <i>…</i>}` a `zb-if` with a `zb-else` (either side may be text, an expression or `null`), and `{list.map((item, i) => <li key={item.id}>…</li>)}` a `zb-each`, keyed by the element's `key`. The markup inside is the template's HTML, one element per brace. Other markup in braces, and markup in an attribute's braces, are errors that say what to write instead.
- `<zb-switch value={…}>` with `<zb-case is="paid">`, `<zb-case is={["shipped", "delivered"]}>` and an optional final `<zb-else>`: the first case whose `is` equals the value, or that lists it, renders. It is the `zb-if` chain it stands for, so known values render on the server.
- `<zb-each items={list} as="item" index="i" key={item.id}>` over any array. `key` is optional; keys must be strings or numbers and unique (checked at build time for known values, and reported at runtime).
- `let:name={…}` on `<zb-each>` or `<zb-then>` names an expression for the row or the result: `<zb-each items={cart} as="item" let:total={item.price * item.qty}>`. It's derived (each read is its current value), read-only, and later `let:`s can use earlier ones.
- `<zb-slot name="…">` with fallback content; without `name`, the default slot.
- `<zb-await value={…}>` with pending content, `<zb-then as="…">` and `<zb-catch as="…">` (see Async data).

In the HTML output, directives are expanded at build time and wrapped in `<?zb [?>` … `<?zb ]?>` markers (each list row in its own pair), so the element can find them when it hydrates. In the browser:

- `zb-if` re-renders only when the chosen branch changes.
- `zb-each` without a key updates rows in place by position. Each row holds its item and index as signals, so changing one item updates only that row. Rows are added and removed at the end.
- With `key`, rows follow their key. Reordering moves the existing rows with their DOM state (a half-typed input, focus), using `moveBefore()` where the browser has it. Inserting or removing in the middle touches only those rows.

## Classes, styles, events and references

```html
<script>
  let open = false
  let panel = null                                         // ref={panel} assigns the element
  function save() { … }
</script>
<zb-panel tone="teal" size={12}>
  <zb-document onkeydown.escape={() => (open = false)}></zb-document>
  <section ref={panel} class="panel" class:open class:big={size > 20}
           style:--tone={tone} style:font-size={size + "px"}>
    <form onsubmit.prevent={save}>
      <input onkeydown.enter={save} onkeydown.shift.enter={() => …}>
    </form>
  </section>
  <zb-if test={size > 20}>Big<zb-else-if test={size > 10}>Medium</zb-else-if><zb-else>Small</zb-else></zb-if>
</zb-panel>
```

- **`class:name={…}`** adds the class while the value is truthy; bare `class:open` reads `open`. `class={{ open, big: size > 20 }}` is the same as one toggle per entry. They combine with a static `class`, and with a computed one, whose classes are then added and removed token by token.
- **`style:property={…}`** sets one property: lowercase CSS names or `--custom-properties`; `null` or `false` removes it. `style={{ fontSize: …, "--tone": … }}` sets several (camelCase names become kebab-case). Values are set through the CSSOM (`style.setProperty`), so a value can't add declarations; on the server, a value with `;`, braces, `<`, a backslash or `url()` is refused. A static `style="…"` attribute is allowed; interpolating into one isn't.
- **Event modifiers**: `onsubmit.prevent`, `.stop`, `.once`, `.self` (only events on the element itself), `.capture`, `.passive`. Key filters on `keydown`/`keyup`/`keypress`: `.enter`, `.escape` (`.esc`), `.space`, `.tab`, `.up`/`.down`/`.left`/`.right` (or `.arrowup`, …), `.delete`, `.backspace`, `.home`, `.end`, `.pageup`, `.pagedown`, and any single letter or digit. Several keys mean any of them (`onkeydown.enter.space`). With a key filter, `.shift`, `.ctrl`, `.alt` and `.meta` must be held and the others not, so `onkeydown.enter` and `onkeydown.shift.enter` don't overlap. `.mod` is ⌘ on Apple platforms and Ctrl elsewhere (`onkeydown.mod.enter`). `.submit` submits the element's form after any handler, with `requestSubmit()`, so validation and `submit` listeners run: `<select onchange.submit>` needs no handler at all. They work on child components' events too (`onvaluechange.stop`).
- **`value:bind={color}`** on a child custom element keeps a two-way (`:model`) prop and a `let` (or prop) in step: it's `value={color}` plus `onvaluechange={(event) => (color = event.detail)}`.
- **`ref={name}`** assigns the element to a `let` once rendered, and `null` when it's removed. `ref={(element) => …}` calls a function instead.
- **`{...object}`** spreads an object's entries onto an element, the way headless libraries hand out behaviour: `<input {...api.getInputProps()} class="field">`. Functions under `on<Name>` keys are listeners (`onClick`, `onkeydown`), replaced when the function changes. `value`, `checked`, `selected` and `indeterminate` are properties, and `className`/`htmlFor` mean `class`/`for`. `class` merges token by token with the element's own classes. `style` is an object set through the CSSOM. `true` is a bare attribute, `aria-*` booleans are written as `"true"`/`"false"`, and `false`, `null` and `undefined` remove the attribute. Entries that disappear are removed, and an attribute written on the element itself wins. A spread can't do what an attribute couldn't: text handlers, `style` text, unsafe URLs and markup keys (`innerHTML`, `srcdoc`, …) are refused. A spread known at build time renders on the server; otherwise the element applies it. It works on HTML elements and other libraries' custom elements, not on the host, a directive or an imported Zubra component (pass each prop). Its code is in `@zubra/runtime/spread` (about 1.4 KB gzipped), which a compiled module imports only when its template spreads; an import map needs that entry too.
- **`<zb-window>` and `<zb-document>`** take event listeners (with modifiers), added while they're rendered and removed after. They render nothing.
- **`<zb-else-if test={…}>`** goes between `zb-if` and its `zb-else`.
- **In scripts and JSX**, the modifiers are functions from `@zubra/runtime`: `prevent(fn)`, `stop(fn)`, `selfOnly(fn)`, `submit(fn)` and `keys('shift+enter', fn)` (`keys('mod+enter', fn)` for ⌘/Ctrl). In JSX, `className={{ … }}`, `style={{ … }}`, `class:open={…}` and `ref={panel}` work as in `.zb`.

## Script, state and hooks

```html
<script>
  import { onMount } from '@zubra/runtime'
  let count = 0                        // state: assigning it updates the template
  const doubled = count * 2            // derived from state and props: stays in sync
  function increment() {
    count++
    if (count > 9) label = "Many"      // props are names in the script, readable and writable
  }
  onMount(() => console.log('connected'))
</script>
<zb-counter label="Clicks">
  <button type="button" onclick={increment}>{label}: {count} ({doubled})</button>
</zb-counter>
```

- **A prop's name is the prop**, in the script as in the template: read `label`, assign `label = …` (the element updates as if it were set from outside). So the script can't declare a name a prop has. A default taken from the script uses another name: `<zb-card title={titleDefault}>`.
- **A top-level `let` is state.** Reading it in the template, in a `computed` or an effect tracks it, and assigning it (`count++`, `count = 0`, `count += 2`) updates what reads it. Its initial value renders on the server.
- **Mutating state works too**: `items.push(x)`, `items.splice(i, 1)`, `items[0].done = true`, `form.email = "…"`, `delete form.email`. A `let` holding an array or a plain object holds a reactive proxy of it, which tracks each property separately, so `items[0].done = true` updates only what read it, and nested arrays and objects are wrapped as they're read. Class instances, `Map`, `Set`, `Date`, DOM nodes and functions aren't wrapped. The proxy is the same object each time and works as the original does (`Array.isArray`, `JSON.stringify`, spread, every method), but it isn't the original: `raw(items)` from `@zubra/runtime` gives that back, for `structuredClone`, `postMessage` or a library that compares by identity. Props aren't wrapped (they're the parent's); `let draft = from(items)` is a mutable copy that follows one.
- **`let left = from(seconds)`** (from `@zubra/runtime`) is state that follows a prop until it's assigned, and starts over when the prop changes: a timer's time left resets when its length does. `let running = from(seconds, false)` starts as `false` instead, again whenever `seconds` changes. A plain `let left = seconds` reads the prop once. `zubra convert` writes `from()` for React's `useState(prop)` plus an effect that resets it.
- **A top-level `const` that reads props or state** (outside nested functions) is derived: it's recomputed when they change. Other `const`s, functions and imports are plain JavaScript, run once per element.
- `state()` and `computed()` give explicit signals, for custom hooks and shared state. A `const` holding one (from `state`, `computed`, `inject`, `hasSlot` or `hydrated`) **reads like a value**, in the template and in the script: `user.name` means `user.get().name`, and a `const` derived from it (`const me = user?.name`) stays in sync like any other. `.get()` and `.set(…)` written out still work. To pass the signal itself (`watch(signal(count), …)`, `formValue(signal(count))`), wrap it in `signal()` from `@zubra/runtime`.
- **`name:model={default}` on the host** makes a prop two-way: assigning it in the script fires `<name>change` (detail: the new value) when it changes, and the event is declared in the typings and manifest. Setting it from outside fires nothing. Frameworks' two-way binding (`v-model`, `bind:`, Angular's `ZubraModel`) listen for exactly that event. In JSX, `function Stepper({ value = model(0) })`.
- **`declare const name: Type`** in `<script lang="ts">` gives a prop its type (for the typings, manifest and child checks) without a default's help: `declare const size: 'small' | 'large'`. A `declare const` that names no prop is an error.

Hooks are plain functions called while the script runs (once per element; nothing re-renders, so there are no hook rules beyond that):

| Hook | |
|---|---|
| `state(value)`, `computed(fn)` | Signals (`Signal.State`, `Signal.Computed`) |
| `effect(fn)`, `watch(source, (next, prev) => …)` | Run on change; `effect` may return a cleanup |
| `onMount(fn)`, `onUnmount(fn)` | Connected / disconnected; `onMount` may return a cleanup |
| `props()` | The element's props as an object, for custom hooks (in the script, use the names) |
| `host()` | The element |
| `emit(name, detail)` | Fire an event (see Events) |
| `id()` | An id unique to this element and call, for `id`/`for`/`aria-*` |
| `hasSlot(name = 'default')` | A signal: whether content was given for a slot (see Slots) |
| `createContext`, `provide`, `inject` | Context (see below) |
| `formValue`, `validity`, `onFormReset`, `onFormRestore`, `onFormDisabled` | Form controls (see below) |
| `resource(fetcher)` | Async data (see below) |

Custom hooks are plain functions that call these. A detached element pauses: long-lived signals stop holding it, and on return only the parts whose inputs changed re-run.

## Async data

`resource(fetcher)` holds async data as signals: `value`, `error`, `status` (`"pending"`, `"ready"`, `"error"`) and `loading`, plus `refresh()`. It is awaitable too.

```html
<script>
  import { resource, props } from '@zubra/runtime'
  const p = props()
  const user = resource(({ signal }) => fetch(`/api/users/${p.userId}`, { signal }).then((r) => r.json()))
</script>
<zb-user user-id="1">
  <zb-await value={user}>
    <zb-pending><p>Loading…</p></zb-pending>
    <zb-then as="data"><h2>{data.name}</h2></zb-then>
    <zb-catch as="error"><p class="error">{error.message} <button onclick={retry}>Try again</button></p></zb-catch>
  </zb-await>
</zb-user>
```

- **The fetcher re-runs** when a signal it read before its first `await` changes (here the `id` prop). A new run aborts the previous one through the `AbortSignal` it was given, and so does the element's removal. An answer that arrives after a newer run started is dropped. While a new run is pending, `value` keeps the previous result.
- **`<zb-await value={…}>`** shows `<zb-pending>` while the value is pending, then `<zb-then as="name">` with the resolved value, or `<zb-catch as="name">` with the error. All three are optional, and pending content written straight inside, before `<zb-then>`, works as `<zb-pending>` does. It takes a promise, a `resource()` (followed through its states, so a reload shows the pending content again) or a plain value (`zb-then` at once). Only the latest value's outcome is shown. `<zb-await {user}>` is short for `value={user}`.
- **Several values at once**: an array `value={[user, posts]}` waits for every promise and resource in it, as `Promise.all` does, and resolves to the array of their values; any rejection goes to `zb-catch`.
- **Destructuring**: `as` on `zb-then`, `zb-catch` and `zb-each`, and the item of `.map()` in braces, can be a pattern: `as="[{ name }, list]"`, `as="{ message }"`, `as="{ id, address: { city } }"`. Names, renames (`{ id: key }`), nesting and holes work. Defaults and rest elements are errors; use `??` where the value is read.
- **`retry()`**, in `zb-catch`, refreshes the value's resources and evaluates the value again, so `value={load()}` calls `load()` again.
- **`delay={ms}`** shows the pending content only once the value has been pending that long, so a quick answer doesn't flash a spinner. **`keep`** keeps the settled content while a resource reloads, and the host has `:state(loading)` meanwhile, for a dimmed or spinning style.
- **On the server**, a value known at build time renders `zb-then`. Otherwise the pending content is rendered in a region the element renders itself once the value settles.

## Slots

- **Light DOM** (the default): the element's children are placed in its `zb-slot` regions by their `slot` attribute; everything else goes to the default slot. An empty slot shows its fallback, which stays live. Slotted content in an `zb-if` branch comes back when the branch does. Content for a slot that doesn't exist is reported.
- **Slotted content stays live.** Frameworks keep managing an element's children through the host (`appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `append`, `replaceChildren`, `textContent`, `innerHTML`, as React and Vue do), and those calls are routed to the slots. Content removed through its real parent leaves its slot, changing an element's `slot` attribute moves it, and an emptied slot shows its fallback again. Reading `childNodes` on the host shows the rendered template.
- **Shadow DOM** (`shadow`): `zb-slot` compiles to a native `<slot>`, and supplied content is light DOM with `slot="…"`, as declarative shadow DOM expects.
- A slot can't be inside `zb-each`.
- **`hasSlot(name)`** says whether content was given for a slot, and follows it as content comes and goes, in light and shadow DOM. For markup that only makes sense around a used slot:

```html
<script>
  import { hasSlot } from '@zubra/runtime'
  const hasFooter = hasSlot('footer')
</script>
<zb-card>
  <zb-slot></zb-slot>
  <zb-if test={hasFooter}><footer><zb-slot name="footer"></zb-slot></footer></zb-if>
</zb-card>
```

## Styles

```html
<style>
  :host { display: block }
  h2 { color: var(--card-accent, crimson) }
</style>
<zb-card heading="">
  <h2>{heading}</h2>
  <zb-slot></zb-slot>
</zb-card>
```

- **Scoped with the platform's own `@scope`.** In light DOM, a component's `<style>` applies to its own elements and stops at content callers put in its slots. The runtime and the HTML output mark each slotted element `data-zb-slotted="zb-card"`, and the stylesheet is `@scope (zb-card) to ([data-zb-slotted="zb-card"])`. The marker names the component, so a parent's content placed in a child's slot is still the parent's to style, as with shadow DOM. The marker is removed when content leaves the slot. In shadow DOM the shadow root does the scoping and the CSS is used as written. `:host` means the host either way, so one stylesheet works with or without `shadow`.
- **`host-reset`** (with `shadow`) is for components on pages you don't control: embeds and extensions' widgets. The host is in the page, so a page's `* { … !important }` matches it and beats `:host`, and fonts and colours inherit into the shadow root. `host-reset` starts the host from `all: initial` and makes the component's own top-level `:host` declarations `!important`, which wins across the shadow boundary.
- **Utilities and app CSS win.** The CSS goes in the `components` cascade layer, and the sheet declares Tailwind's layer order (`theme, base, components, utilities`). Utility classes override a component's defaults, base and reset styles come before them, and unlayered page CSS overrides both, whichever stylesheet loads first. `<style layer="…">` picks another layer; `<style layer="none">` leaves the CSS unlayered.
- **Page CSS still applies in light DOM.** Tailwind, Bootstrap or your own global classes work on a component's elements as on any element. A parent's styles can also reach into a light-DOM child's elements, as page CSS does; use `shadow` when a component needs full isolation.
- **Delivery.** In the browser, each component's stylesheet is one constructed `CSSStyleSheet`, shared by every instance. A light-DOM component's sheet is adopted by the document, or by the shadow root it lives in. A shadow component's sheet is adopted by each of its shadow roots. In the HTML output, a shadow component carries a `<style>` in its declarative shadow root. Light-DOM styles go in the page once: `--emit css` writes the stylesheets of a component and everything it imports, for the page's `<head>`.
- **Through the bundler.** With `@zubra/unplugin` in Vite, each `<style>` is a CSS module that Vite's pipeline processes: PostCSS, Tailwind (`@reference "tailwindcss"` and `@apply` work), and preprocessors with `<style lang="scss">` (or `less`, `stylus`). Leading `@import`, `@use` and `@reference` statements stay at the top of the sheet. Without a bundler, `lang` other than CSS is an error, and `@import` isn't available, because constructed stylesheets don't support it.
- **Shadow DOM and app-wide CSS.** Page CSS doesn't reach into shadow roots. `adoptStyles(sheet)` from `@zubra/runtime` adds a stylesheet (CSS text, or a `CSSStyleSheet` such as `import sheet from './app.css' with { type: 'css' }`) to every Zubra shadow root, now and later. That's how Tailwind's output or a design system reaches shadow components.

### Tailwind CSS

Light-DOM components need no setup: utility classes in templates are just classes. Tailwind 4 detects `.zb` files with its other sources; if your components are somewhere it doesn't look, add `@source "./components";` to your CSS. Inside a component's `<style>`, add `@reference "tailwindcss";` to use `@apply` and theme values. For shadow components, pass Tailwind's compiled CSS to `adoptStyles`. `examples/frameworks/tailwind-cafe/` does both. [Zubra with Tailwind, shadcn/ui, MUI and Bootstrap](docs/guide/styling-libraries.md) covers the others, each with an example app.

## Events

```html
<!--
  A star rating.
  @fires beforevaluechange - Cancelable: preventDefault() keeps the current value.
  @fires valuechange - The value changed; `detail` is the new value.
-->
<script>
  import { emit, props } from '@zubra/runtime'
  const p = props()
  function rate(stars) {
    if (!emit('beforevaluechange', stars)) return   // a listener called preventDefault()
    p.value = stars
    emit('valuechange', stars)
  }
</script>
<zb-rating value={0}> … </zb-rating>
```

- **Nothing is declared by hand.** Each `emit("name", detail)` call declares an event. The compiler binds `emit` to each element, so handlers and timers can call it at any time. The name must be a string literal, and `emit` must be called directly (not passed around), so the compiler sees every event.
- **Names follow the platform**: lowercase letters and digits, like the DOM's own events (`valuechange`, `itemselect`), and native names where the meaning matches (`change`, `toggle`, `close`). `valueChange` or `value-change` is an error that suggests `valuechange`. Every framework can listen for these names declaratively.
- **Events are `CustomEvent`s** dispatched from the host, with the value in `detail`. They bubble, and shadow components' events are also `composed`. `before…` events are cancelable, and `emit` returns `false` when a listener called `preventDefault()`.
- **A component's events are its own**: an inner element's event with the same name (a native `change` from an inner `<input>`, a nested component's `valuechange`) stops at the host. Listeners outside, including on the host itself, see only the component's own event, as with built-in elements. Capture-phase listeners above the host still see inner events.
- **Two-way binding comes from naming**: a `<prop>` + `<prop>change` pair (`value` + `valuechange`) is what the Vue adapter's `v-model` and React's controlled pattern bind to.
- **Parents listen** with `on<name>={handler}`. On an imported component, a listener for a near miss of one of its events (`onvaluchange`) is a compile error with a suggestion.
- **`@fires name - text`** lines in the description document events. When there are any, they must match the emitted events exactly.
- Detail types come from the values passed (`emit('select', { id: 1 })` → `CustomEvent<{ id: number }>`; a variable is `unknown`).

## Components using components

```html
<script>
  import './badge.zb'
</script>
<zb-inbox items={[]}>
  <zb-each items={items} as="item" key={item.name}>
    <zb-badge label={item.name} info={{ color: item.unread > 0 ? "red" : "gray" }}>
      <em slot="icon">{item.unread}</em>new mail
    </zb-badge>
  </zb-each>
</zb-inbox>
```

- **Importing a `.zb` file** makes its tag a known child, loaded relative to the importing file. Cycles, a component imported twice, and a component importing itself are errors.
- **Props are checked at the call site.** Each attribute must be one of the child's props (or a global, `data-`/`aria-` or event attribute), with a "did you mean" for typos. Its value must have the type of the child's default, and required props must be given. Errors inside the child name the child's file.
- **HTML output** renders the child inline (a declarative shadow root for shadow children), with the parent's content in the child's slots, as markup both components hydrate.
- **JavaScript output** imports the child's module and passes props as properties, so objects and arrays arrive as values. The parent's content stays bound to the parent's state.
- **Other libraries' custom elements** get an attribute until the element is defined with a matching property, then the property (React 19's rule). So `config={{ … }}` reaches a Lit or Stencil element as an object.

## Forms

`form-associated` on the host makes the element a form control on the platform's `ElementInternals`:

- `formValue(signal)` sets what the form submits, under the element's `name`. Without it, a control with exactly one `:model` prop submits that prop (`null`, `false` and `''` submit nothing, `true` submits `"on"`, objects JSON), and a form reset restores the prop's initial value.
- `validity(() => message)` takes part in validation. `''` means valid; otherwise the form won't submit, and `:invalid`/`:valid` match.
- `onFormReset`, `onFormRestore` and `onFormDisabled` follow the form's lifecycle. A disabled `<fieldset>` disables the control and leaves it out of the submitted data.

The element gets the native control API (`form`, `name`, `labels`, `validity`, `validationMessage`, `willValidate`, `checkValidity()`, `reportValidity()`), and its typings declare it.

In the HTML output, `<select value={…}>` marks the matching `<option selected>` (by its `value`, or its text), and `<textarea value={…}>` becomes the textarea's content, since HTML ignores a `value` attribute on both. Before JavaScript, the page shows the right choice.

**Progressive enhancement.** `hydrated()` from `@zubra/runtime` is a signal that's `false` in the server's HTML and `true` once the element has started. Use it for what only works with JavaScript:

```html
<script>
  import { hydrated } from '@zubra/runtime'
  const live = hydrated()
</script>
<my-filters status="">
  <form><select name="status" value={status} onchange.submit>…</select>
    <zb-if test={!live}><button>Apply</button></zb-if></form>
</my-filters>
```

The host also gets the custom state `hydrated`, for CSS: `:host(:state(hydrated))` in shadow DOM, or `my-filters:state(hydrated)` from the page. On the server, `live && …` and `!live || …` are decided by `live` alone.

**Server functions.** A script may export a function marked `'use server'`, and only such a function (type-only exports in `<script lang="ts">`, `export interface` and `export type`, declare no value and are allowed; they reach the typings). It never reaches the browser: its name becomes its endpoint's URL, and `<form action={save}>` (or `formaction={save}`) becomes a plain `action="/_zb/action/<tag>/save" method="post"`, so the form works without JavaScript. Imports only the function uses leave the browser module too. `--emit server` writes the server half, and `@zubra/actions` serves it; its script turns those posts into `fetch` requests and fires `action` on the form with the result. `docs/actions.md` has the contract.

```html
<script>
  let saved = false
  export async function save(formData) { 'use server'; await db.save(formData.get('note')); return { ok: true } }
</script>
<note-form><form action={save} onaction={(event) => (saved = event.detail.value?.ok)}>…</form></note-form>
```

**State on the device.** `'use collection tasks'` at the top of a script keeps its top-level `let`s in IndexedDB (through `@zubra/sync`), as the document keyed by the `doc` prop: `<task-item doc="t42">` is `tasks/t42`. Assignments update the page at once and the store behind it; the state survives reloads, works offline, and other elements and tabs showing the same document follow. `let editing = ephemeral(false)` is state that isn't stored. `docs/sync.md` has the rules. It needs `@zubra/sync` installed; a bundler or `@zubra/server` picks it up from there, and if it's missing the error says which component needs it and what to run.

**Directives.** Zubra knows two: `'use collection <name>'` first in a script (`@zubra/sync`), and `'use server'` first in an exported function (`@zubra/actions`). Anything else written as a directive gets a warning that says what was probably meant: `'use colection'` gets "did you mean 'use collection'", and `'use client'` is explained as unneeded, since every component already runs in the browser. Until 5.3 a stray directive was ignored, so in 5.x it still compiles; 6.0 makes it an error.

## Context

`createContext(default)`, `provide(context, value)` and `inject(context)` follow the Web Components Community Group [Context Protocol](https://github.com/webcomponents-cg/community-protocols/blob/main/proposals/context.md). `inject` returns a signal that follows the nearest provider above the element. A consumer defined before its provider still connects; one that's moved asks again; one that's removed unsubscribes. Because the protocol is plain DOM events, Zubra components share context with other implementations such as Lit's `@lit/context`.

## Server rendering and hydration

`docs/server-rendering.md` is the plain account: what renders where, what works without JavaScript, and the gaps that remain.

The HTML output is the server rendering: static, deterministic, escaped markup. Props that differ from their defaults are written onto the host (JSON for arrays and objects). When the element starts in the browser, it first checks that the markup has its template's shape. If it does, it binds to the existing DOM: nothing is re-rendered, and a part writes only when its value differs. Markup that doesn't match is replaced, with a warning.

### Hydration markers

The markers are processing instructions: `<?zb [?>` and `<?zb ]?>` around a region, `<?zb [??>` for a region left to the browser, `<?zb [!?>` for supplied slot content, and `<?zb ?>` before dynamic text. `Document.parseHTMLUnsafe()` (which htmx uses) and the HTML parser keep them:
- Chrome and Edge 150+ parse each as a `ProcessingInstruction` node;
- other browsers parse it as a comment (`<!--?zb [?-->`), which the runtime reads the same way.

HTML minifiers mostly keep them: html-minifier-terser and @minify-html/node as shipped, @swc/html and htmlnano with one option each (`ZUBRA_MARKER_PATTERN` and `ZUBRA_MARKER_DIRECTIVE` from `@zubra/compiler`). Sanitizers (DOMPurify, sanitize-html) remove them. `server/test/markers.test.js` measures each, and [Server rendering, honestly](docs/server-rendering.md#hydration-markers-through-minifiers-and-sanitizers) has the table with the options.

A tool that removes them costs one extra script. An element whose markup lost every marker puts them back by structure and hydrates in place anyway. It walks its template against the markup:
- a text anchor's text runs up to the next element;
- an `zb-if` holds the branch the current values choose, and an `zb-each` one row per item, checked element by element;
- a light-DOM slot that ends its range holds the rest (its fallback, if it has the fallback's shape);
- an `zb-await` holds its `zb-then` block for a value the server knew at build time, or its pending block, which the element renders afresh anyway (so only where the region ends has to be found).

The code that does this (`remark.js`) is loaded only when an element meets such markup. Where the shape can't be placed for sure (content projected into a child component, or markup that isn't the template's), the element renders fresh, with a warning that the markers are missing. Every registry component hydrates in place this way (`registry/test/stripped.test.js`, `service-status` with its pending `zb-await` included), and so do settled `zb-await`s (`runtime/test/browser/components.test.js`), keeping text typed and focus taken before JavaScript.

### In frameworks that hydrate

In Next.js, React Router, Nuxt and SvelteKit, the framework hydrates the server's HTML around the elements. The React and Vue wrappers render an element's content into its host on the server (a light-DOM element's rendered children, a shadow-DOM element's declarative shadow root) and keep the framework out of the host while hydrating (React: `dangerouslySetInnerHTML` with an empty string in the browser and `suppressHydrationWarning`; Vue: a vnode with no children), so the element hydrates in place either way. Two cases still need `shadow`: an element given React or Vue children (slot content), and every component under SvelteKit, which uses elements directly and claims every node it finds. `@zubra/unplugin` warns about both. Solid leaves nodes it didn't render alone; `zubra.injectShadowRoots(html, { lightDom: true })` gives its light-DOM hosts their children. See `examples/meta/README.md`.

**The SSR bridge.** A framework renders only the host tag. For the element's markup to be in the page before JavaScript, there are two steps:
1. **Props on the host.** The React and Vue wrappers write the props as one JSON attribute, `zb-props`, on the server and in the browser alike. In Svelte and Solid, which use elements directly, `@zubra/unplugin` adds it in the server build, from the attributes that set the element's props (`log={…}`, `{log}`, `bind:value={…}`, Solid's `prop:items={…}`). The element starts with these props before the framework sets them.
2. **Shadow roots in the HTML.** `zubra.injectShadowRoots(html)` on the instance `createZubra()` from `@zubra/server` returns, or `zubra.injectShadowRootsStream()` for a streamed page, gives each shadow-DOM component's host its server-rendered template as a declarative shadow root. The browser attaches it while parsing, before any framework hydrates, and the element then hydrates it in place. A form-associated component with a `name` also gets `<input type="hidden" data-zb-fallback>` holding its value, so the form submits without JavaScript. The element removes it when it starts.

Where to call it:

| Framework | Hook |
|---|---|
| SvelteKit | `handle`'s `transformPageChunk` |
| Nuxt | a Nitro plugin on `render:html` |
| React Router | `app/entry.server.jsx` (the stream) |
| SolidStart | a middleware |
| Next.js | none: the loader's server build (below) |

`examples/meta/` has each. Next.js streams React Server Components and has no hook for its HTML, so there the React wrapper writes the shadow root itself. For a shadow-DOM element with no React children, on the server, the host's inner HTML is its declarative shadow root, plus the form fallback. The browser attaches the shadow root while parsing, and React doesn't hydrate inner HTML, so nothing disagrees. An element given React children (slot content) is left to the browser there. A control the user types into (a text field inside a shadow root) still needs JavaScript to submit. Its server-rendered value goes, but not an edit.

### What the server can render

The HTML output evaluates the component's JavaScript where the answer is the same everywhere:
- in templates and in the script's `const`s and `let`s: literals, props, member access, arithmetic, comparisons, logic, ternaries and template literals;
- arrow functions defined in the script (`const money = (cents) => …`), and arrow callbacks;
- string, array and number methods: `.includes`, `.map`, `.filter`, `.reduce`, `.join`, `.slice`, `.padStart`, `.toFixed`, `.toSorted`, …;
- `Math` (except `random`), `Number()`, `String()`, `Boolean()` and `Object.keys()`, `Object.values()` and `Object.entries()`.

That's the same in the Rust CLI, the WebAssembly build and every server. `compiler/test/server-evaluation.test.js` checks it against V8. What isn't deterministic (`Date`, `Intl`, `Math.random()`, `toLocaleString()`), what reaches the browser (`window`, `document`), and anything else outside the subset is left for the browser. `zubra check --server` lists those places, rendering with the defaults. It's an error for `checked`, `selected`, `value` and `disabled`, because without JavaScript the form would be wrong.

**Partial rendering.** A component may use what only the browser can compute: JavaScript expressions, runtime-only script values, or defaults computed in the browser. `--partial` (or `partial: true` in a request) renders everything else and leaves those parts for the element. Their text renders empty, their attributes are left out, and their conditionals and lists become empty `<?zb [??>` regions that the element renders when it starts, without a hydration warning. Without it, the HTML output reports the first such part as an error. `@zubra/compiler`'s `render()` and the plugin's server builds render partially, so every component (JSX ones with state included) can be server-rendered.

In an app's server, **`@zubra/server`** does the whole job with any template engine. It renders components into a page, adds their CSS and module scripts, and serves the browser modules and `@zubra/runtime`, with no bundler:

```js
import { zubra } from '@zubra/server/express';          // or /fastify, /hono; or createZubra() from '@zubra/server'
app.use(zubra({ components: 'components' }));
app.get('/', (req, res) => {
  const page = res.locals.zubra;
  res.send(page.finish(layout(page.render('ticket-table', { tickets }))));
});
```

`page.finish(html)` puts the used components' CSS and the import map before `</head>`, and their modules before `</body>`. `page.head()` and `page.scripts()` give you the same pieces to place yourself. `zubra.handle(req, res)` (Node) and `zubra.fetch(request)` (fetch-style servers) serve `/_zubra/…`. For a static site, `zubra.writeAssets(dir)` writes those files. `examples/helpdesk/` (Express and EJS), `examples/hypermedia/` (Hono) and `examples/meta/eleventy-trails/` use it.

**Streaming.** A prop given as a promise renders as pending: the component's `<zb-await>` shows its pending content, in an empty region. `page.stream(html)` (a Node stream; `page.streamResponse(html)` a web `Response`) sends the page at once and, as each promise settles, the resolved region in a `<template for>` and an inline script that hands the element the value. The pending region is a named range (`<?start name="zb-0-0"?>`…`<?end?>`), so a browser with out-of-order streaming (Chrome and Edge 150+) puts the resolved region in place itself, without JavaScript; elsewhere, and in a shadow root, which a `<template for>` can't reach, the script does it before the element starts. An element that has started renders the region itself. It hydrates the region as it would any server-rendered `zb-then`; a rejection reaches its `zb-catch`. `page.pending` says whether anything is streaming. Without JavaScript and out-of-order streaming the pending content stays, so await the data before rendering when the page must be complete without it. The help desk's dashboard streams its recent activity.

`@zubra/compiler` underneath renders a single component, from Node and without Rust:

```js
import { render } from '@zubra/compiler';
const { html, css } = render('src/inbox.zb', { props: { heading: 'Mail' }, slots: { default: '<p>Hi</p>' } });
```

Slot content here is HTML your server already rendered and is kept as written (comments, scripts and braces included; `slotSource: 'template'` reads it as Zubra syntax instead). A compiled module also loads on a server, where `define()` returns a stand-in carrying the element's description, so framework server rendering can import it. In a server build, `@zubra/unplugin` registers each component's renderer, and `renderToString(Element, { props, attributes, slots })` from `@zubra/runtime/server` renders the element class. With Astro, `@zubra/unplugin/astro` does all of this: components render on the server, and `client:load` (or any client directive) hydrates them. In Nuxt, SvelteKit, React Router and SolidStart, the framework renders the host and its children, and `@zubra/server` adds the shadow roots (see "The SSR bridge").

The JavaScript output is a module that calls `define()` on `@zubra/runtime` with the component's props, template, parts and script. Parts are found by paths that count elements and markers only, because browsers merge and drop text nodes. Dynamic text beside other nodes follows an empty anchor, which both outputs emit (`<?zb ?>` in the HTML, `<!---->` in the module's template).

## Using components in an app

`@zubra/unplugin` (in `plugin/`) compiles `.zb` imports in Vite, Rollup, webpack, esbuild and Rspack. What an import gives depends on the importing file: a React component in `.jsx`/`.tsx` files, a Vue component in `.vue` files, the element class elsewhere. Props, events, two-way binding and children all work without glue code, and typings are written next to each component. See `plugin/README.md`.

**Next.js** (Turbopack) and other bundlers that take webpack-style loaders, but not plugins, use `@zubra/unplugin/loader`. The module it makes defines the element and, as its default export, wraps it as a React client component (`?element` gives the element alone):

```js
// next.config.mjs
const loader = '@zubra/unplugin/loader';
export default {
  serverExternalPackages: ['@zubra/compiler'], // the server renders with it at request time
  turbopack: {
    rules: {
      '*.zb': [
        { condition: 'browser', loaders: [loader], as: '*.js' },
        // The server's build also registers how to render each component.
        { condition: { not: 'browser' }, loaders: [{ loader, options: { server: true } }], as: '*.js' },
      ],
    },
  },
};
```

With only the first rule, the elements still work; they draw in the browser.

The adapters it uses can also be used by hand: `wrap(Element)` from `@zubra/runtime/react` (React 18 and 19) or `@zubra/runtime/vue` (Vue 3). Other frameworks (Svelte, Solid, Lit, Preact, Angular) and plain HTML use the element directly: properties in, DOM events out. The plugin detects Svelte, Solid and Preact projects and writes typings for them. Astro has an integration, `@zubra/unplugin/astro` (see above).

Angular needs `CUSTOM_ELEMENTS_SCHEMA` and nothing else for props (`[heading]="x"`), events (`(valuechange)="…"`) and children. For forms, `ZubraModel` from `@zubra/runtime/angular` makes the element a control through its `<prop>` + `<prop>change` pair (`[(value)]` can't work, because Angular listens for `valueChange`):

```ts
@Component({
  imports: [FormsModule, ZubraModel],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `<zb-rating zubraModel [(ngModel)]="stars"></zb-rating>`,
})
```

`zubraModel="checked"` names the pair when it isn't `value`. With Analog's Vite plugin (`@analogjs/vite-plugin-angular`), which compiles Angular ahead of time inside Vite, `.zb` files are imported directly like in any Vite app. The Angular CLI's builder doesn't take Vite or esbuild plugins, so there, compile components with `zubra compile --emit js` (or `@zubra/compiler`) into `.js` modules and import those.

Lit apps put Zubra elements in their shadow roots: a light-DOM component's styles are adopted into the shadow root it's in, with or without a bundler. Context crosses libraries too, since both follow the context protocol: a value from `@lit/context`'s `ContextProvider` reaches `inject()` with the same context key.

`examples/frameworks/` has a complete app for each framework (React, Vue, Svelte, Solid, Lit, Preact, Angular), tested in a browser.

## Sharing components

**Publish a library** with one command (`zubra` comes with `@zubra/compiler`; no Rust needed):

```sh
npx zubra build --lib src/components --out dist   # name and version from ./package.json, or --name/--version
cd dist && npm publish
```

`--watch` rebuilds after each change (a compile error keeps the last good build), for an app that imports the library while you work on it, such as Next.js, whose bundler takes no plugins.

The package needs no bundler or Zubra tooling on the consumer's side:

- an ES module per element (`@acme/ui/quantity-stepper`), and `index.js` exporting every element by class name;
- `@acme/ui/react` and `@acme/ui/vue`: each element as a React or Vue component, with two-way props, events and children working as through the plugin;
- typings for all of them, including the React and Vue component types;
- `custom-elements.json`, the [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest), referenced from `package.json`'s `customElements` field for IDEs, documentation tools and Storybook;
- `skills/using-<name>/SKILL.md`: how to use the components, for coding agents, written from the manifest;
- `package.json` with `exports` for each of the above, `@zubra/runtime` as a peer dependency, and `react` and `vue` as optional peers.

`buildLibrary(dir, options)` from `@zubra/compiler/library` does the same from a script. `examples/frameworks/ui/` is one, built from the registry, and the React and Vue example apps import it like a package from npm.

**Start from the registry.** `npx zubra add tag-input` copies an accessible component from `registry/` into `src/components/`, and it's yours to change. There are twenty-six, from form controls and charts to tabs, menus, tooltips, a combobox and a live status check, each tested from the keyboard and by role and accessible name. `npx zubra add --list` lists them; `registry/README.md` has the details and the theme properties. For the widgets Radix and shadcn/ui give React apps (menus, tabs, tooltips, comboboxes), see [Accessible widgets without a headless library](docs/guide/accessible-widgets.md): the platform, two keyboard primitives in `@zubra/runtime/primitives`, and Zag.js through `@zubra/runtime/zag`.

**Storybook.** With `@storybook/web-components`, give Storybook the manifest and it fills each story's controls and docs (attributes, properties, events, slots, descriptions) from it:

```js
// .storybook/preview.js
import { setCustomElementsManifest } from '@storybook/web-components';
import manifest from '@acme/ui/custom-elements.json';   // or the manifest zubra writes for your own components
setCustomElementsManifest(manifest);

// quantity-stepper.stories.js
import '@acme/ui/quantity-stepper';
export default { component: 'quantity-stepper' };
export const Default = { args: { value: 2, max: 5 } };
```

## Moving in from React

`zubra convert` rewrites a React function component as a Zubra JSX component next to it (`TodoItem.jsx` becomes `todo-item.zb.jsx`, `<todo-item>`):

```sh
zubra convert src/TodoItem.jsx              # or npx zubra convert, from @zubra/compiler (without --component)
zubra convert src/Counter.jsx --prefix app  # one-word names need a prefix: <app-counter>
zubra convert src/Menu.jsx --component MenuItem   # one of several exported components
zubra convert src/TodoItem.jsx --as zubra     # the HTML-first .zb file instead of JSX (once nothing is left to finish)
```

The body of a Zubra component runs once per element, so the hooks become what they stand for:

| React | becomes |
|---|---|
| `const [count, setCount] = useState(0)`, `setCount(c => c + 1)` | `let count = 0`, `count = ((c) => c + 1)(count)` |
| `useMemo(() => x, deps)`, `useCallback(fn, deps)` | `x` (derived: it stays in sync), `fn` |
| `useRef(null)` and `ref.current` | `let ref = null` and `ref` |
| `useEffect(fn, [])` | `onMount(fn)` |
| `useEffect(fn, deps)` | `onMount(() => effect(fn))`: after the DOM updates, re-run when what it reads changes |
| `const [s, dispatch] = useReducer(r, init)` | `let s = init` and `const dispatch = (action) => (s = r(s, action))` |
| `createContext(x)`, `useContext(Ctx)` | the runtime's `createContext` and `inject(Ctx)` (the Context Protocol); a `<Ctx.Provider>` is reported: the parent calls `provide(Ctx, value)` |
| `<Child onClose={onClose}>` (a received event prop, passed on) | `onClose={(event) => onClose(event)}`, since an event prop fires the event |
| `onChange` on a text field, `onDoubleClick` | `onInput`, `onDblClick` (the DOM's events) |

`zubra convert` also goes the other way: given a custom element class in the shape `--emit element` writes (one you compiled and then changed, or one written by hand the same way), `zubra convert my-element.js` writes the `.zb` component it means. Every component `--emit element` accepts comes back to a `.zb` file that compiles to the same element. See [Plain elements](docs/plain-elements.md#back-to-zb-zubra-convert).

Preact's hooks (`preact/hooks`) convert the same way. Comments and formatting are kept, since only what changes is rewritten. What it can't convert, it reports, with advice, and it exits with status 1:
- custom hooks, a context created in another module, an exported context (a component file exports only its component), `<Context.Provider>`;
- props taken as one object rather than destructured;
- a spread onto another component, the rest of the props used anywhere but spread onto the returned element, and `dangerouslySetInnerHTML`.

shadcn-style components convert: `{...props}` spread onto the returned element is dropped (the host carries the consumer's attributes itself), `className` becomes the host's own `class`, the props' React type goes, and a spread onto an element is a Zubra spread. A component built on a third-party React primitive (Radix, Headless UI, React Aria, cmdk, vaul, …) is refused up front, with what to use instead: its behaviour is the primitive's, and there's no HTML to convert to. `docs/convert-measured.md` runs it over shadcn/ui: 50 of the 68 components in its plain-markup files convert and compile, and the 46 primitive-based files are refused with one message each.

The result is compiled as part of the conversion, and a compile error is shown at its place in the output. With `--out` in another folder, relative imports are adjusted to it.

`examples/frameworks/react-board/CONVERTED.md` walks through a real one: the board's card editor, converted from React, with what was finished by hand.

## Editors and tooling without Rust

- **`@zubra/compiler`** (`compiler/`) is the compiler built to WebAssembly, for Node: the same output and errors as the CLI, with no Rust toolchain. `@zubra/unplugin` uses it automatically when it's installed.
- **Editor support** (`editors/`): a language server (diagnostics as you type, completion, hover, go to definition) and a VS Code extension with syntax highlighting, [on the Marketplace](https://marketplace.visualstudio.com/items?itemName=JourneytoCode.zubra) (`code --install-extension JourneytoCode.zubra`). See [docs/editor-support.md](docs/editor-support.md) and `editors/README.md`. In the browser, the **Zubra DevTools** pane maps a selected node to its `.zb` line and shows the signals each binding reads ([editors/devtools](editors/devtools/README.md)).
- **`--emit html-data`** writes VS Code HTML custom data, for completing Zubra elements in plain `.html` files.

## One file, no runtime: `--emit element`

`zubra compile toggle-switch.zb --emit element` writes the component as the custom element you'd write by hand: one class that extends `HTMLElement`, with `observedAttributes`, `attributeChangedCallback`, a getter and setter per prop, the template's changing nodes found and named, and one line per binding that says what it reads and which DOM call writes it. It imports nothing, so a page can load it with a `<script type="module">` and nothing installed, and it's written to be read: it's how to learn the platform from your own component. The runtime's browser suites and the registry's tests run on both outputs in CI. Only the helpers a component uses go in (keyed lists, light-DOM slots), so a small element is about 2 KB gzipped (3.5 KB with slots), against 13 KB for the shared runtime plus each component's module: plain output is smaller for a page with a few components, and the runtime for a page with many. What it leaves out (shadow DOM, server hydration, spreads, `zb-await`, hot reload, `resource` and the other runtime extras) is refused with a reason, pointing at `--emit js`. See [docs/plain-elements.md](docs/plain-elements.md).

## Describing components to tools

- `--emit manifest` writes a [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest) (`custom-elements.json`, schema 2.1.0): the tag, each prop as an attribute and a field with its type and default, events with their `CustomEvent<…>` types, slots (the default slot is `""`) and the description. Editors, Storybook and documentation tools read this format. `--module-path` sets the module path it records.
- `--emit dts` writes TypeScript declarations: the element class with typed properties and typed `addEventListener`, a `…Props` interface, an `…EventMap`, the `tag` constant and an `HTMLElementTagNameMap` entry. `--framework react|vue|svelte|solid` types the default export as that framework's wrapper, which is what the plugin writes.
- Types are inferred from defaults: `{ sample: "…" }` becomes `{ sample: string }`, `["a"]` becomes `string[]`, and a required prop with no default is `unknown`.

## Safety

Dynamic values are escaped or written as text. URL attributes must be relative or `http`, `https`, `mailto` or `tel`, checked at build time and again at runtime. Boolean attributes take booleans. String event handlers, interpolated `style` text, and `<script>`/`<style>` inside templates are rejected. See `docs/security.md` for the full model.

## The CLI

```sh
zubra check <component.zb>... [--format human|json] [--server] [--stdin]
zubra fmt <file.zb | folder>... [--check] [--indent <n> | --tabs] [--width <n>]   (--stdin: source in, formatted out)
zubra compile <component.zb> [--emit html|js|element|css|dts|manifest|html-data|interface] [--props <props.json>] [--slots <slots.json> [--slots-html]] [--partial]
                             [--runtime <module>] [--keep-imports] [--no-imports] [--devtools] [--framework react|vue|svelte|solid|none]
                             [--css-import <specifier> --css-import-inline <specifier>]
                             [--module-path <path>] [--output <file>]
zubra convert <Component.jsx | my-element.js> [--prefix <word>] [--component <Name>] [--as jsx|zubra] [--out <file> | --stdout]
zubra request < request.json
zubra serve
```

`zubra check` reports every error and warning in the given files without writing anything (exit status 1 on errors; `--format json` for editors and CI annotations; `--stdin` checks unsaved text as if it were at the one path given). It runs every check that doesn't need prop values; what the HTML output can't render is reported only with `--server`, as warnings (errors for `checked`, `selected`, `value` and `disabled`). `--emit html` (the default) writes server-rendered HTML. `--emit css` writes the scoped stylesheets of a component and the components it imports (`--no-imports` for its own only). `--props` and `--slots` supply values (defaults come from the component); `--slots-html` reads the slots as server-rendered HTML, kept as written, and `--partial` leaves what only the browser can compute for the element. `--emit js` writes the element module: `--runtime` changes the runtime import (default `@zubra/runtime`), and `--keep-imports` leaves `./x.zb` imports for a bundler (otherwise they become `./x.js`), and `--css-import <specifier> --css-import-inline <specifier>` imports the `<style>` through the bundler instead of inlining it, and `--devtools` adds what the browser DevTools panel reads (each part's source location, the script's signals by name, the file's path; for development builds, which `@zubra/unplugin` makes in Vite's dev server). `--emit element` writes the same element as one file with no runtime to install (see [Plain elements](docs/plain-elements.md)). `--emit dts` writes declarations (`--framework` for a wrapper's) and `--emit manifest` the manifest. Output goes to stdout, or to `--output <file>` with an atomic write. Warnings go to stderr. `zubra check --server` also reports what a server without JavaScript leaves out (see "What the server can render"). `zubra request` takes one JSON request on stdin and writes the JSON response, the interface the WebAssembly build exposes (see `src/request.rs`). `{ "requests": [ … ] }` is a batch, answered as `{ "ok", "responses": [ … ] }`. `zubra serve` keeps running and answers one request (or batch) per line on stdin with one response per line on stdout, for servers in other languages that render often (`examples/backends/flask-garden/garden/zubra.py`).

### Formatting

`zubra fmt` lays a `.zb` file out consistently without changing what it compiles to. It re-indents the template to its nesting (2 spaces, `--indent <n>` or `--tabs`), keeps at most one blank line, tidies the inside of tags (one space between attributes, none around `=`, ` />`), and puts one attribute per line when a tag that starts its line doesn't fit in `--width` (default 100). It never adds or removes whitespace where there was no line break, because that can move inline elements. It leaves `{…}` expressions, comments, attribute values, `<script>` and `<style>` bodies and everything inside `<pre>` and `<textarea>` exactly as written. So the compiled output differs only in the length of whitespace runs that render as one space; the test suite checks that for every component in the repository. (An element whose CSS sets `white-space: pre` shows its indentation: put that content in a `<pre>`.)

**`<script>` and `<style>` with Prettier.** `zubra fmt` leaves those bodies alone. `prettier-plugin-zubra` formats a `.zb` file with Prettier: the template exactly as `zubra fmt` lays it out (the plugin calls the compiler's `format()`), and each `<script>` and `<style>` body by Prettier with your configuration (JavaScript, TypeScript for `lang="ts"`, CSS, SCSS and Less), indented one level inside its tag. A body that doesn't parse, or is in a language Prettier has no parser for, stays as written; `embeddedLanguageFormatting: "off"` leaves all bodies as written. See [`prettier-plugin/`](prettier-plugin/README.md).

Folders are searched for `.zb` files (skipping `node_modules`, `dist`, `target` and dot-folders). `--check` writes nothing and fails if a file would change, for CI. A file that doesn't parse is reported and left alone, and so is a JSX component, which Prettier formats. In an editor, the language server formats on Format Document and on save (see [docs/editor-support.md](docs/editor-support.md)). From JavaScript it's `format(source, options)` in `@zubra/compiler`, and in the request API `command: "format"`.

## Standards

Zubra is meant to be absorbed by the platform. These reports give the standards discussions evidence from using it:

- [`docs/standards/README.md`](docs/standards/README.md) indexes them; feedback is welcome, see `CONTRIBUTING.md`.
- [`docs/standards/signals.md`](docs/standards/signals.md): an integration report for the TC39 Signals proposal, including two reference-polyfill behaviours the README rules out and the cost of unwatching one effect at a time.
- [`docs/standards/dom-parts.md`](docs/standards/dom-parts.md): what a parts model needed in practice (markers, regions, hydration), for DOM Parts and declarative templating.
- [`docs/standards/declarative-custom-elements.md`](docs/standards/declarative-custom-elements.md): the `.zb` format as a worked declarative custom elements explainer.
- [`docs/standards/one-source-n-consumers.md`](docs/standards/one-source-n-consumers.md): the case for one source against agent-made ports, with numbers: what the compiler generates for the registry across the matrix, the ten framework bugs the adapters absorbed once, and an experiment where an agent ported three components to three frameworks (47 behavioural differences before any change; a fix propagated to all six ports without error).
- [`docs/framework-matrix.md`](docs/framework-matrix.md): what each framework's row in CI proves, and what isn't in a row.

## Stability

5.x freezes, until 6.0:
- the authoring formats (`.zb`: script semantics, host tag and flags, `{expr}`, directives, slots, keys, imports, `emit`; JSX components);
- the CLI's commands and options, and the outputs' behaviour;
- the runtime's documented exports.

The generated JavaScript's internal shape (`$define()`'s arguments, parts) is not public API. It is versioned (`abi`): a runtime refuses modules compiled for an `abi` it can't read with an error that says to recompile, instead of misbehaving.

Browser support: `docs/browser-support.md`.

## Repository and tests

- `src/`: the compiler (Rust): scanner, parser, script analysis with oxc, resolver and lowering, HTML renderer, JavaScript and interface emitters, CLI.
- `runtime/`: `@zubra/runtime`, with the React, Vue and Angular adapters and the server registry.
- `plugin/`: `@zubra/unplugin`, with the Astro integration.
- `compiler/`: `@zubra/compiler`, the compiler as WebAssembly; `wasm/` is its Rust shim.
- `editors/`: the language server, the VS Code extension and the browser DevTools extension.
- `create/`: `create-zubra`, the starter (`npm create zubra`), with a template per framework.
- `playground/`: the in-browser playground.
- `demos/`: the demo gallery: `demos/build.mjs` builds the landing page, the documentation site, the playground and every static example under one base path, `.github/workflows/pages.yml` publishes it to GitHub Pages, and `demos/shots/` holds every example's screenshot (`demos/screenshots.mjs` for the static ones; the others' tests take theirs with `ZUBRA_SHOTS`).
- `docs/guide/`: the tutorial.
- `site/`: the landing page and the documentation site, built with Eleventy (`npm ci` there first). The page compiles its sample component and its own Copy button (a `.zb` file) when it's built and reads the by-hand version out of this README, so the code it shows is the real output. The docs render the Markdown in `docs/`, this README and the CHANGELOG (`site/src/_data/nav.js` lists the pages, and a link to a file that doesn't exist fails the build). `demos/build.mjs` runs it.
- `docs/who-this-is-for.md`, `docs/what-crosses-the-boundary.md`, `docs/server-rendering.md`: where Zubra fits, which components fit through an element, and the server story with its gaps.
- `registry/`: the components `zubra add` copies, with their accessibility tests.

Install Rust 1.97 or newer and Node 20 or newer.

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
(cd runtime && npm ci && npm test)       # unit tests, incl. Signals differential tests
(cd runtime && npm run test:browser)     # Chromium: components, hydration, slots, events, adapters, leaks, benchmarks
(cd runtime && npm run test:tools)       # manifest schema, TypeScript checks, size budgets
(cd plugin && npm ci && npm test)        # real apps: React, Vue, Svelte, Solid, Lit, Astro, Tailwind; Rollup, webpack, esbuild
(cd compiler && npm test)                # render API (and, with zubra.wasm built, parity with the CLI)
(cd create && npm test)                  # the starter's command line
node --test "registry/test/*.test.js"    # the registry's components: keyboard and screen-reader behaviour
(cd examples/frameworks && npm ci && npm test)  # the framework apps, and every starter's own browser test
node --test "playground/test/*.test.js"  # the playground in Chromium
node demos/build.mjs --base /zubra/ && node --test "demos/test/*.test.js"  # the demo gallery, served as Pages serves it
```

The browser and plugin suites need Playwright's Chromium (`npx playwright install chromium`). `.github/workflows/ci.yml` runs every suite on each push. Behaviour is mutation-checked: each feature's code was deliberately broken in turn to confirm a test fails.

## License

ISC. See `LICENSE`.
