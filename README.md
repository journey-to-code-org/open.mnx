# mnx

mnx is a compiler for Web Components. You write a component as HTML with `{expr}` bindings and a `<script>`. mnx turns it into server-rendered HTML and a small custom element that hydrates that HTML. React, Vue and any other framework can then use the element without integration code.

The runtime is built on what the web platform is standardizing: the TC39 Signals API, template parts in the shape of DOM Parts, the Context Protocol, form-associated custom elements and declarative shadow DOM. The aim is for the platform to absorb what mnx proves, so the runtime shrinks as native features ship. See `runtime/README.md`.

**Start here:** `npm create mnx@latest` writes a working app for your framework (or none), with a dev server that updates components in place. The [playground](https://journey-to-code-org.github.io/open.mnx/) runs mnx in your browser, and [the guide](docs/guide/README.md) is a tutorial, with pages for React, Vue and Svelte developers. This README is the reference.

**Status: 3.x.** The `.mnx` and JSX formats, the CLI and the runtime's public API are stable: no breaking changes before 4.0. See `CHANGELOG.md`, `docs/migrating-to-3.0.md` for components written for 2.x, `docs/migrating-to-2.0.md` for 1.x, and `docs/migrating-from-0.2.md` for 0.2.

```html
<!-- copy-button.mnx -->
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
mnx compile copy-button.mnx --props props.json   # the HTML a server sends, for {"text":"npm create mnx"}:
#   <copy-button text="npm create mnx"><button type="button">Copy</button></copy-button>
mnx compile copy-button.mnx --emit js             # the custom element that hydrates it
```

```html
<copy-button text="npm create mnx"></copy-button>      <!-- plain HTML -->
```
```tsx
<CopyButton text="npm create mnx" />                   // React or Vue, through @mnx/unplugin: same file, typed
```

<details>
<summary>The same element written by hand (about 55 lines)</summary>

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

It needs shadow DOM to scope one style rule, has no server HTML, and has the two bugs most hand-written elements have (a forgotten `#render()`, a listener removed with a different reference). The compiler writes all of it.
</details>

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

**Who it's for.** One component with more than one consumer: a component library or design system used from more than one framework, components handed to other people's stacks, anything that has to live in a CMS, an older app or a static site, and servers that aren't JavaScript. If one app on one framework is the only consumer, you don't need it; [Who mnx is for](docs/who-this-is-for.md) says why, and [What crosses the boundary](docs/what-crosses-the-boundary.md) says which components fit through an element and which belong in the framework. Astro lets frameworks coexist on a page; mnx lets one component be used by all of them.

## Writing a component

- **The host tag declares the component.** Its name is the custom element. Its attributes are the props: `title={titleDefault}` declares a prop whose default comes from the script, `label="Hi"` a string default, and a bare `name` a required prop. Kebab-case attributes become camelCase props (`max-value` → `maxValue`). The default's type is the prop's type. `shadow` opts into shadow DOM (light DOM is the default) and `form-associated` makes the element a form control. A comment above the component becomes its description in the generated docs and types.
- **The host is the root**: the template can have any number of top-level nodes.
- **Defaults computed in the browser.** A prop whose default uses a value only the browser has (`since={start}` with `const start = Date.now()`, or anything reading `window`, `document`, `Math` and other globals) gets it per element, after the script runs, unless the prop was given by an attribute or property. The HTML output needs that prop from `--props` (or from the parent), and says so.
- **`<script>` is real JavaScript** (parsed with oxc), run once per element. Top-level `const`/`let` initializers written in the expression language (they may use props) are also evaluated at build time for the HTML output. A top-level `let` is state, and props are names (see Script, state and hooks). Using a runtime-only value in static HTML is a compile error that says so (or, with `--partial`, left for the element).
- **`<script lang="ts">`** is TypeScript, reduced to JavaScript by removing its types in place, so every line and column stays where it was and errors point into your source. Only erasable syntax is accepted, as with Node's type stripping or TypeScript's `erasableSyntaxOnly`. `enum`, `namespace`, parameter properties, `<T>x` assertions and `import x = require()` are errors that say what to write instead. The types aren't lost: a prop whose default is an annotated binding (`const options: Option[] = …`, then `options={options}`) has that type, `emit<Picked>("pick", …)` types the event's `detail`, and the script's `type`/`interface` declarations are exported from the generated typings.
- **`{expr}`** works in text, in quoted attributes (`class="card {kind}"`, always a string) and as a whole attribute value (`data={value}`, any type). An expression in the build-time subset is evaluated by the HTML output too: literals, arrays and objects, member and index access (with `?.`), `!` `-` `+` `*` `/` `%`, comparisons, `==`/`!=` (strict), `&&` `||` `??` and `? :`, with JavaScript's truthiness. Signals read in the template (`{count}`) are reactive.
- **Any other JavaScript expression runs in the browser**: calls (`{format(price)}`, `{items.filter((item) => item.done).length}`), arrow-function handlers that close over list items (`onclick={() => remove(item.id)}`), `new`. Names mean what they mean in the script: a signal `const` reads as its value (`{count * 2}`), and props and list items read as in the subset. A template can assign to props only (`onclick={() => { open = !open }}`), and `emit()` in a template declares its event like one in the script. The HTML output can't evaluate these, so a component that renders one needs the JavaScript output (handlers are never rendered, so inline handlers don't count).
- **Names resolve** to loop variables, then props, then script bindings. Every reference is checked in every branch, including branches a build won't render, and unknown names get a "did you mean" suggestion. Errors point at the source line with a caret.
- **Events from the template**: `onclick={increment}` calls a script function, read when the event fires; `onclick={() => rate(2)}` works too.
- **Warnings** flag props that shadow built-in element properties (a `hidden` prop also hides the element; `title` also shows a tooltip).

## JSX components

A component can also be a function in a `.mnx.jsx` or `.mnx.tsx` file. It compiles to the same element as an `.mnx` file, and the two formats import each other.

```jsx
// rating.mnx.jsx
/** A two-star rating. */
export default function MnxRating({ value = 0, onValueChange }) {
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

- **The function's name is the tag**: `MnxRating` is `<mnx-rating>` (custom elements need a hyphen, so `Rating` is an error). Return the host itself (`<mnx-rating shadow>…</mnx-rating>`) to set `shadow` or `form-associated`.
- **Destructured parameters are props**, with their defaults; one without a default is required. **`on<Name>` parameters are events**: calling `onValueChange(x)` fires `valuechange` with `detail: x`, so React users pass `onValueChange` and everyone else listens for `valuechange`. **`children`** is the default slot; `<mnx-slot name="…">` declares named ones.
- **The body runs once per element**, not on every change. A top-level `let` is state, a top-level `const` that reads props or state is derived, and everything in the returned JSX is a fine-grained binding.
- **In the JSX**: `cond && <X/>` and `cond ? <A/> : <B/>` are conditionals, `list.map((item, i) => <li key={item.id}>…</li>)` is a keyed list, imported components are used by name (`import Badge from './badge.mnx'`, then `<Badge label="x" />`), and `className`, `htmlFor` and `onClick` mean `class`, `for` and `onclick`. Any JavaScript expression works, as in `.mnx` templates.
- Errors point into the JSX. Not supported yet, each with an error that says what to do instead: spread props and attributes, `ref`, render props (JSX in attributes), renamed or nested destructured props, early returns, and module-level `let`. Prop types come from defaults, and JSX components have no `<style>` yet.

`plan/decisions/jsx-components.md` in the project docs records the design.

## Directives

- `<mnx-if test={…}>`, with an optional final `<mnx-else>`.
- `<mnx-each items={list} as="item" index="i" key={item.id}>` over any array. `key` is optional; keys must be strings or numbers and unique (checked at build time for known values, and reported at runtime).
- `<mnx-slot name="…">` with fallback content; without `name`, the default slot.
- `<mnx-await value={…}>` with pending content, `<mnx-then as="…">` and `<mnx-catch as="…">` (see Async data).

In the HTML output, directives are expanded at build time and wrapped in `<!--[-->` … `<!--]-->` markers (each list row in its own pair), so the element can find them when it hydrates. In the browser:

- `mnx-if` re-renders only when the chosen branch changes.
- `mnx-each` without a key updates rows in place by position. Each row holds its item and index as signals, so changing one item updates only that row. Rows are added and removed at the end.
- With `key`, rows follow their key. Reordering moves the existing rows with their DOM state (a half-typed input, focus), using `moveBefore()` where the browser has it. Inserting or removing in the middle touches only those rows.

## Classes, styles, events and references

```html
<script>
  let open = false
  let panel = null                                         // ref={panel} assigns the element
  function save() { … }
</script>
<mnx-panel tone="teal" size={12}>
  <mnx-document onkeydown.escape={() => (open = false)}></mnx-document>
  <section ref={panel} class="panel" class:open class:big={size > 20}
           style:--tone={tone} style:font-size={size + "px"}>
    <form onsubmit.prevent={save}>
      <input onkeydown.enter={save} onkeydown.shift.enter={() => …}>
    </form>
  </section>
  <mnx-if test={size > 20}>Big<mnx-else-if test={size > 10}>Medium</mnx-else-if><mnx-else>Small</mnx-else></mnx-if>
</mnx-panel>
```

- **`class:name={…}`** adds the class while the value is truthy; bare `class:open` reads `open`. `class={{ open, big: size > 20 }}` is the same as one toggle per entry. They combine with a static `class`, and with a computed one, whose classes are then added and removed token by token.
- **`style:property={…}`** sets one property: lowercase CSS names or `--custom-properties`; `null` or `false` removes it. `style={{ fontSize: …, "--tone": … }}` sets several (camelCase names become kebab-case). Values are set through the CSSOM (`style.setProperty`), so a value can't add declarations; on the server, a value with `;`, braces, `<`, a backslash or `url()` is refused. A static `style="…"` attribute is allowed; interpolating into one isn't.
- **Event modifiers**: `onsubmit.prevent`, `.stop`, `.once`, `.self` (only events on the element itself), `.capture`, `.passive`. Key filters on `keydown`/`keyup`/`keypress`: `.enter`, `.escape` (`.esc`), `.space`, `.tab`, `.up`/`.down`/`.left`/`.right` (or `.arrowup`, …), `.delete`, `.backspace`, `.home`, `.end`, `.pageup`, `.pagedown`, and any single letter or digit. Several keys mean any of them (`onkeydown.enter.space`). With a key filter, `.shift`, `.ctrl`, `.alt` and `.meta` must be held and the others not, so `onkeydown.enter` and `onkeydown.shift.enter` don't overlap. `.mod` is ⌘ on Apple platforms and Ctrl elsewhere (`onkeydown.mod.enter`). `.submit` submits the element's form after any handler, with `requestSubmit()`, so validation and `submit` listeners run: `<select onchange.submit>` needs no handler at all. They work on child components' events too (`onvaluechange.stop`).
- **`value:bind={color}`** on a child custom element keeps a two-way (`:model`) prop and a `let` (or prop) in step: it's `value={color}` plus `onvaluechange={(event) => (color = event.detail)}`.
- **`ref={name}`** assigns the element to a `let` once rendered, and `null` when it's removed. `ref={(element) => …}` calls a function instead.
- **`<mnx-window>` and `<mnx-document>`** take event listeners (with modifiers), added while they're rendered and removed after. They render nothing.
- **`<mnx-else-if test={…}>`** goes between `mnx-if` and its `mnx-else`.
- **In scripts and JSX**, the modifiers are functions from `@mnx/runtime`: `prevent(fn)`, `stop(fn)`, `selfOnly(fn)`, `submit(fn)` and `keys('shift+enter', fn)` (`keys('mod+enter', fn)` for ⌘/Ctrl). In JSX, `className={{ … }}`, `style={{ … }}`, `class:open={…}` and `ref={panel}` work as in `.mnx`.

## Script, state and hooks

```html
<script>
  import { onMount } from '@mnx/runtime'
  let count = 0                        // state: assigning it updates the template
  const doubled = count * 2            // derived from state and props: stays in sync
  function increment() {
    count++
    if (count > 9) label = "Many"      // props are names in the script, readable and writable
  }
  onMount(() => console.log('connected'))
</script>
<mnx-counter label="Clicks">
  <button type="button" onclick={increment}>{label}: {count} ({doubled})</button>
</mnx-counter>
```

- **A prop's name is the prop**, in the script as in the template: read `label`, assign `label = …` (the element updates as if it were set from outside). So the script can't declare a name a prop has. A default taken from the script uses another name: `<mnx-card title={titleDefault}>`.
- **A top-level `let` is state.** Reading it in the template, in a `computed` or an effect tracks it, and assigning it (`count++`, `count = 0`, `count += 2`) updates what reads it. Its initial value renders on the server.
- **Mutating state works too** (since 3.2): `items.push(x)`, `items.splice(i, 1)`, `items[0].done = true`, `form.email = "…"`, `delete form.email`. A `let` holding an array or a plain object holds a reactive proxy of it, which tracks each property separately, so `items[0].done = true` updates only what read it, and nested arrays and objects are wrapped as they're read. Class instances, `Map`, `Set`, `Date`, DOM nodes and functions aren't wrapped. The proxy is the same object each time and works as the original does (`Array.isArray`, `JSON.stringify`, spread, every method), but it isn't the original: `raw(items)` from `@mnx/runtime` gives that back, for `structuredClone`, `postMessage` or a library that compares by identity. Props aren't wrapped (they're the parent's); `let draft = from(items)` is a mutable copy that follows one.
- **`let left = from(seconds)`** (from `@mnx/runtime`) is state that follows a prop until it's assigned, and starts over when the prop changes: a timer's time left resets when its length does. `let running = from(seconds, false)` starts as `false` instead, again whenever `seconds` changes. A plain `let left = seconds` reads the prop once. `mnx convert` writes `from()` for React's `useState(prop)` plus an effect that resets it.
- **A top-level `const` that reads props or state** (outside nested functions) is derived: it's recomputed when they change. Other `const`s, functions and imports are plain JavaScript, run once per element.
- `state()` and `computed()` give explicit signals, for custom hooks and shared state. A `const` holding one (from `state`, `computed`, `inject`, `hasSlot` or `hydrated`) **reads like a value**, in the template and (since 3.0) in the script: `user.name` means `user.get().name`, and a `const` derived from it (`const me = user?.name`) stays in sync like any other. `.get()` and `.set(…)` written out still work. To pass the signal itself (`watch(signal(count), …)`, `formValue(signal(count))`), wrap it in `signal()` from `@mnx/runtime`.
- **`name:model={default}` on the host** makes a prop two-way: assigning it in the script fires `<name>change` (detail: the new value) when it changes, and the event is declared in the typings and manifest. Setting it from outside fires nothing. Frameworks' two-way binding (`v-model`, `bind:`, Angular's `MnxModel`) listen for exactly that event. In JSX, `function Stepper({ value = model(0) })`.
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
  import { resource, props } from '@mnx/runtime'
  const p = props()
  const user = resource(({ signal }) => fetch(`/api/users/${p.id}`, { signal }).then((r) => r.json()))
</script>
<mnx-user id="1">
  <mnx-await value={user}>
    <p>Loading…</p>
    <mnx-then as="data"><h2>{data.name}</h2></mnx-then>
    <mnx-catch as="error"><p class="error">{error.message}</p></mnx-catch>
  </mnx-await>
</mnx-user>
```

- **The fetcher re-runs** when a signal it read before its first `await` changes (here the `id` prop). A new run aborts the previous one through the `AbortSignal` it was given, and so does the element's removal. An answer that arrives after a newer run started is dropped. While a new run is pending, `value` keeps the previous result.
- **`<mnx-await value={…}>`** shows its content while the value is pending, then `<mnx-then as="name">` with the resolved value, or `<mnx-catch as="name">` with the error. Both are optional. It takes a promise, a `resource()` (followed through its states, so a reload shows the pending content again) or a plain value (`mnx-then` at once). Only the latest value's outcome is shown.
- **On the server**, a value known at build time renders `mnx-then`. Otherwise the pending content is rendered in a region the element renders itself once the value settles.

## Slots

- **Light DOM** (the default): the element's children are placed in its `mnx-slot` regions by their `slot` attribute; everything else goes to the default slot. An empty slot shows its fallback, which stays live. Slotted content in an `mnx-if` branch comes back when the branch does. Content for a slot that doesn't exist is reported.
- **Slotted content stays live.** Frameworks keep managing an element's children through the host (`appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `append`, `replaceChildren`, `textContent`, `innerHTML`, as React and Vue do), and those calls are routed to the slots. Content removed through its real parent leaves its slot, changing an element's `slot` attribute moves it, and an emptied slot shows its fallback again. Reading `childNodes` on the host shows the rendered template.
- **Shadow DOM** (`shadow`): `mnx-slot` compiles to a native `<slot>`, and supplied content is light DOM with `slot="…"`, as declarative shadow DOM expects.
- A slot can't be inside `mnx-each`.
- **`hasSlot(name)`** says whether content was given for a slot, and follows it as content comes and goes, in light and shadow DOM. For markup that only makes sense around a used slot:

```html
<script>
  import { hasSlot } from '@mnx/runtime'
  const hasFooter = hasSlot('footer')
</script>
<mnx-card>
  <mnx-slot></mnx-slot>
  <mnx-if test={hasFooter}><footer><mnx-slot name="footer"></mnx-slot></footer></mnx-if>
</mnx-card>
```

## Styles

```html
<style>
  :host { display: block }
  h2 { color: var(--card-accent, crimson) }
</style>
<mnx-card heading="">
  <h2>{heading}</h2>
  <mnx-slot></mnx-slot>
</mnx-card>
```

- **Scoped with the platform's own `@scope`.** In light DOM, a component's `<style>` applies to its own elements and stops at content callers put in its slots. The runtime and the HTML output mark each slotted element `data-mnx-slotted="mnx-card"`, and the stylesheet is `@scope (mnx-card) to ([data-mnx-slotted="mnx-card"])`. The marker names the component, so a parent's content placed in a child's slot is still the parent's to style, as with shadow DOM. The marker is removed when content leaves the slot. In shadow DOM the shadow root does the scoping and the CSS is used as written. `:host` means the host either way, so one stylesheet works with or without `shadow`.
- **`host-reset`** (with `shadow`) is for components on pages you don't control: embeds and extensions' widgets. The host is in the page, so a page's `* { … !important }` matches it and beats `:host`, and fonts and colours inherit into the shadow root. `host-reset` starts the host from `all: initial` and makes the component's own top-level `:host` declarations `!important`, which wins across the shadow boundary.
- **Utilities and app CSS win.** The CSS goes in the `components` cascade layer, and the sheet declares Tailwind's layer order (`theme, base, components, utilities`). Utility classes override a component's defaults, base and reset styles come before them, and unlayered page CSS overrides both, whichever stylesheet loads first. `<style layer="…">` picks another layer; `<style layer="none">` leaves the CSS unlayered.
- **Page CSS still applies in light DOM.** Tailwind, Bootstrap or your own global classes work on a component's elements as on any element. A parent's styles can also reach into a light-DOM child's elements, as page CSS does; use `shadow` when a component needs full isolation.
- **Delivery.** In the browser, each component's stylesheet is one constructed `CSSStyleSheet`, shared by every instance. A light-DOM component's sheet is adopted by the document, or by the shadow root it lives in. A shadow component's sheet is adopted by each of its shadow roots. In the HTML output, a shadow component carries a `<style>` in its declarative shadow root. Light-DOM styles go in the page once: `--emit css` writes the stylesheets of a component and everything it imports, for the page's `<head>`.
- **Through the bundler.** With `@mnx/unplugin` in Vite, each `<style>` is a CSS module that Vite's pipeline processes: PostCSS, Tailwind (`@reference "tailwindcss"` and `@apply` work), and preprocessors with `<style lang="scss">` (or `less`, `stylus`). Leading `@import`, `@use` and `@reference` statements stay at the top of the sheet. Without a bundler, `lang` other than CSS is an error, and `@import` isn't available, because constructed stylesheets don't support it.
- **Shadow DOM and app-wide CSS.** Page CSS doesn't reach into shadow roots. `adoptStyles(sheet)` from `@mnx/runtime` adds a stylesheet (CSS text, or a `CSSStyleSheet` such as `import sheet from './app.css' with { type: 'css' }`) to every mnx shadow root, now and later. That's how Tailwind's output or a design system reaches shadow components.

### Tailwind CSS

Light-DOM components need no setup: utility classes in templates are just classes. Tailwind 4 detects `.mnx` files with its other sources; if your components are somewhere it doesn't look, add `@source "./components";` to your CSS. Inside a component's `<style>`, add `@reference "tailwindcss";` to use `@apply` and theme values. For shadow components, pass Tailwind's compiled CSS to `adoptStyles`.

## Events

```html
<!--
  A star rating.
  @fires beforevaluechange - Cancelable: preventDefault() keeps the current value.
  @fires valuechange - The value changed; `detail` is the new value.
-->
<script>
  import { emit, props } from '@mnx/runtime'
  const p = props()
  function rate(stars) {
    if (!emit('beforevaluechange', stars)) return   // a listener called preventDefault()
    p.value = stars
    emit('valuechange', stars)
  }
</script>
<mnx-rating value={0}> … </mnx-rating>
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
  import './badge.mnx'
</script>
<mnx-inbox items={[]}>
  <mnx-each items={items} as="item" key={item.name}>
    <mnx-badge label={item.name} info={{ color: item.unread > 0 ? "red" : "gray" }}>
      <em slot="icon">{item.unread}</em>new mail
    </mnx-badge>
  </mnx-each>
</mnx-inbox>
```

- **Importing a `.mnx` file** makes its tag a known child, loaded relative to the importing file. Cycles, a component imported twice, and a component importing itself are errors.
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

**Progressive enhancement.** `hydrated()` from `@mnx/runtime` is a signal that's `false` in the server's HTML and `true` once the element has started. Use it for what only works with JavaScript:

```html
<script>
  import { hydrated } from '@mnx/runtime'
  const live = hydrated()
</script>
<my-filters>
  <form><select name="status" value={status} onchange.submit>…</select>
    <mnx-if test={!live}><button>Apply</button></mnx-if></form>
</my-filters>
```

The host also gets the custom state `hydrated`, for CSS: `:host(:state(hydrated))` in shadow DOM, or `my-filters:state(hydrated)` from the page. On the server, `live && …` and `!live || …` are decided by `live` alone.

## Context

`createContext(default)`, `provide(context, value)` and `inject(context)` follow the Web Components Community Group [Context Protocol](https://github.com/webcomponents-cg/community-protocols/blob/main/proposals/context.md). `inject` returns a signal that follows the nearest provider above the element. A consumer defined before its provider still connects; one that's moved asks again; one that's removed unsubscribes. Because the protocol is plain DOM events, mnx components share context with other implementations such as Lit's `@lit/context`.

## Server rendering and hydration

`docs/server-rendering.md` is the plain account: what renders where, what works without JavaScript, and the gaps that remain.

The HTML output is the server rendering: static, deterministic, escaped markup. Props that differ from their defaults are written onto the host (JSON for arrays and objects). When the element starts in the browser, it first checks that the markup has its template's shape. If it does, it binds to the existing DOM: nothing is re-rendered, and a part writes only when its value differs. Markup that doesn't match is replaced, with a warning.

### Hydration markers

The markers are HTML comments (`<!--[-->`, `<!--]-->`, `<!---->`, `<!--[?-->`, `<!--[!-->`). Some tools remove comments: HTML minifiers, some sanitizers, and htmx in some browsers. Since 2.10, an element whose markup lost every comment puts them back by structure and hydrates in place anyway. It walks its template against the markup:
- a text anchor's text runs up to the next element;
- an `mnx-if` holds the branch the current values choose, and an `mnx-each` one row per item, checked element by element;
- a light-DOM slot that ends its range holds the rest (its fallback, if it has the fallback's shape).

The code that does this (`remark.js`) is loaded only when an element meets such markup. Where the shape can't be placed for sure (an `mnx-await`, content projected into a child component), the element renders fresh as before, with a warning that the markers are missing. Every registry component hydrates in place this way (`registry/test/stripped.test.js`). Keeping the markers is still the fast path:
- **html-minifier-terser:** `ignoreCustomComments: [MNX_MARKER_COMMENT]`, imported from `@mnx/compiler` (it's `/^[[\]?!]*$/`).
- **htmx 2:** it parses fragments with `Document.parseHTMLUnsafe()` where it exists, and in some Chromium versions that drops comments. When it does, `delete Document.parseHTMLUnsafe` before htmx loads, so htmx uses `DOMParser`. `examples/hypermedia/hono-bikes/` checks for it first.

### In frameworks that hydrate

In Next.js, React Router, Nuxt and SvelteKit, the framework hydrates the server's HTML around the elements. Since 3.3 the React and Vue wrappers render an element's content into its host on the server (a light-DOM element's rendered children, a shadow-DOM element's declarative shadow root) and keep the framework out of the host while hydrating (React: `dangerouslySetInnerHTML` with an empty string in the browser and `suppressHydrationWarning`; Vue: a vnode with no children), so the element hydrates in place either way. Two cases still need `shadow`: an element given React or Vue children (slot content), and every component under SvelteKit, which uses elements directly and claims every node it finds. `@mnx/unplugin` warns about both. Solid leaves nodes it didn't render alone; `injectShadowRoots(html, { lightDom: true })` gives its light-DOM hosts their children. See `examples/meta/README.md`.

**The SSR bridge.** A framework renders only the host tag. For the element's markup to be in the page before JavaScript, there are two steps:
1. **Props on the host.** The React and Vue wrappers write the props as one JSON attribute, `mnx-props`, on the server and in the browser alike. In Svelte and Solid, which use elements directly, `@mnx/unplugin` adds it in the server build (since 2.10), from the attributes that set the element's props (`log={…}`, `{log}`, `bind:value={…}`, Solid's `prop:items={…}`). The element starts with these props before the framework sets them.
2. **Shadow roots in the HTML.** `@mnx/server`'s `injectShadowRoots(html)`, or `injectShadowRootsStream()` for a streamed page, gives each shadow-DOM component's host its server-rendered template as a declarative shadow root. The browser attaches it while parsing, before any framework hydrates, and the element then hydrates it in place. A form-associated component with a `name` also gets `<input type="hidden" data-mnx-fallback>` holding its value, so the form submits without JavaScript. The element removes it when it starts.

Where to call it:

| Framework | Hook |
|---|---|
| SvelteKit | `handle`'s `transformPageChunk` |
| Nuxt | a Nitro plugin on `render:html` |
| React Router | `app/entry.server.jsx` (the stream) |
| SolidStart | a middleware |
| Next.js | none: the loader's server build (below) |

`examples/meta/` has each. Next.js streams React Server Components and has no hook for its HTML, so there the React wrapper writes the shadow root itself (since 2.11). For a shadow-DOM element with no React children, on the server, the host's inner HTML is its declarative shadow root, plus the form fallback. The browser attaches the shadow root while parsing, and React doesn't hydrate inner HTML, so nothing disagrees. An element given React children (slot content) is left to the browser there. A control the user types into (a text field inside a shadow root) still needs JavaScript to submit. Its server-rendered value goes, but not an edit.

### What the server can render

The HTML output evaluates the component's JavaScript where the answer is the same everywhere:
- in templates and in the script's `const`s and `let`s: literals, props, member access, arithmetic, comparisons, logic, ternaries and template literals;
- arrow functions defined in the script (`const money = (cents) => …`), and arrow callbacks;
- string, array and number methods: `.includes`, `.map`, `.filter`, `.reduce`, `.join`, `.slice`, `.padStart`, `.toFixed`, `.toSorted`, …;
- `Math` (except `random`), `Number()`, `String()` and `Object.keys()`, `Object.values()` and `Object.entries()`.

That's the same in the Rust CLI, the WebAssembly build and every server. `compiler/test/server-evaluation.test.js` checks it against V8. What isn't deterministic (`Date`, `Intl`, `Math.random()`, `toLocaleString()`), what reaches the browser (`window`, `document`), and anything else outside the subset is left for the browser. `mnx check --server` lists those places, rendering with the defaults. It's an error for `checked`, `selected`, `value` and `disabled`, because without JavaScript the form would be wrong.

**Partial rendering.** A component may use what only the browser can compute: JavaScript expressions, runtime-only script values, or defaults computed in the browser. `--partial` (or `partial: true` in a request) renders everything else and leaves those parts for the element. Their text renders empty, their attributes are left out, and their conditionals and lists become empty `<!--[?-->` regions that the element renders when it starts, without a hydration warning. Without it, the HTML output reports the first such part as an error. `@mnx/compiler`'s `render()` and the plugin's server builds render partially, so every component (JSX ones with state included) can be server-rendered.

In an app's server, **`@mnx/server`** does the whole job with any template engine. It renders components into a page, adds their CSS and module scripts, and serves the browser modules and `@mnx/runtime`, with no bundler:

```js
import { mnx } from '@mnx/server/express';          // or /fastify, /hono; or createMnx() from '@mnx/server'
app.use(mnx({ components: 'components' }));
app.get('/', (req, res) => {
  const page = res.locals.mnx;
  res.send(page.finish(layout(page.render('ticket-table', { tickets }))));
});
```

`page.finish(html)` puts the used components' CSS and the import map before `</head>`, and their modules before `</body>`. `page.head()` and `page.scripts()` give you the same pieces to place yourself. `mnx.handle(req, res)` (Node) and `mnx.fetch(request)` (fetch-style servers) serve `/_mnx/…`. For a static site, `mnx.writeAssets(dir)` writes those files. `examples/helpdesk/` (Express and EJS), `examples/hypermedia/` (Hono) and `examples/meta/eleventy-trails/` use it.

**Streaming** (3.3). A prop given as a promise renders as pending: the component's `<mnx-await>` shows its pending content, in an empty region. `page.stream(html)` (a Node stream; `page.streamResponse(html)` a web `Response`) sends the page at once and, as each promise settles, a `<template>` with the resolved region and an inline script that swaps it in before the element starts, or hands the element the value if it has. The element hydrates the region as it would any server-rendered `mnx-then`; a rejection reaches its `mnx-catch`. `page.pending` says whether anything is streaming. Without JavaScript the pending content stays, so await the data before rendering when the page must be complete without it. The help desk's dashboard streams its recent activity.

`@mnx/compiler` underneath renders a single component, from Node and without Rust:

```js
import { render } from '@mnx/compiler';
const { html, css } = render('src/inbox.mnx', { props: { heading: 'Mail' }, slots: { default: '<p>Hi</p>' } });
```

Slot content here is HTML your server already rendered and is kept as written (comments, scripts and braces included; `slotSource: 'template'` reads it as mnx syntax instead). A compiled module also loads on a server, where `define()` returns a stand-in carrying the element's description, so framework server rendering can import it. In a server build, `@mnx/unplugin` registers each component's renderer, and `renderToString(Element, { props, attributes, slots })` from `@mnx/runtime/server` renders the element class. With Astro, `@mnx/unplugin/astro` does all of this: components render on the server, and `client:load` (or any client directive) hydrates them. In Nuxt, SvelteKit, React Router and SolidStart, the framework renders the host and its children, and `@mnx/server` adds the shadow roots (see "The SSR bridge").

The JavaScript output is a module that calls `define()` on `@mnx/runtime` with the component's props, template, parts and script. Parts are found by paths that count elements and comments only, because browsers merge and drop text nodes. Dynamic text beside other nodes follows an empty `<!---->` anchor, which both outputs emit.

## Using components in an app

`@mnx/unplugin` (in `plugin/`) compiles `.mnx` imports in Vite, Rollup, webpack, esbuild and Rspack. What an import gives depends on the importing file: a React component in `.jsx`/`.tsx` files, a Vue component in `.vue` files, the element class elsewhere. Props, events, two-way binding and children all work without glue code, and typings are written next to each component. See `plugin/README.md`.

**Next.js** (Turbopack) and other bundlers that take webpack-style loaders, but not plugins, use `@mnx/unplugin/loader`. The module it makes defines the element and, as its default export, wraps it as a React client component (`?element` gives the element alone):

```js
// next.config.mjs
const loader = '@mnx/unplugin/loader';
export default {
  serverExternalPackages: ['@mnx/compiler'], // the server renders with it at request time
  turbopack: {
    rules: {
      '*.mnx': [
        { condition: 'browser', loaders: [loader], as: '*.js' },
        // The server's build also registers how to render each component (2.11).
        { condition: { not: 'browser' }, loaders: [{ loader, options: { server: true } }], as: '*.js' },
      ],
    },
  },
};
```

With only the first rule, the elements still work; they draw in the browser.

The adapters it uses can also be used by hand: `wrap(Element)` from `@mnx/runtime/react` (React 18 and 19) or `@mnx/runtime/vue` (Vue 3). Other frameworks (Svelte, Solid, Lit, Preact, Angular) and plain HTML use the element directly: properties in, DOM events out. The plugin detects Svelte, Solid and Preact projects and writes typings for them. Astro has an integration, `@mnx/unplugin/astro` (see above).

Angular needs `CUSTOM_ELEMENTS_SCHEMA` and nothing else for props (`[heading]="x"`), events (`(valuechange)="…"`) and children. For forms, `MnxModel` from `@mnx/runtime/angular` makes the element a control through its `<prop>` + `<prop>change` pair (`[(value)]` can't work, because Angular listens for `valueChange`):

```ts
@Component({
  imports: [FormsModule, MnxModel],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `<mnx-rating mnxModel [(ngModel)]="stars"></mnx-rating>`,
})
```

`mnxModel="checked"` names the pair when it isn't `value`. With Analog's Vite plugin (`@analogjs/vite-plugin-angular`), which compiles Angular ahead of time inside Vite, `.mnx` files are imported directly like in any Vite app. The Angular CLI's builder doesn't take Vite or esbuild plugins, so there, compile components with `mnx compile --emit js` (or `@mnx/compiler`) into `.js` modules and import those.

Lit apps put mnx elements in their shadow roots: a light-DOM component's styles are adopted into the shadow root it's in, with or without a bundler. Context crosses libraries too, since both follow the context protocol: a value from `@lit/context`'s `ContextProvider` reaches `inject()` with the same context key.

`examples/frameworks/` has a complete app for each framework (React, Vue, Svelte, Solid, Lit, Preact, Angular), tested in a browser.

## Sharing components

**Publish a library** with one command (`mnx` comes with `@mnx/compiler`; no Rust needed):

```sh
npx mnx build --lib src/components --out dist   # name and version from ./package.json, or --name/--version
cd dist && npm publish
```

`--watch` rebuilds after each change (a compile error keeps the last good build), for an app that imports the library while you work on it, such as Next.js, whose bundler takes no plugins.

The package needs no bundler or mnx tooling on the consumer's side:

- an ES module per element (`@acme/ui/quantity-stepper`), and `index.js` exporting every element by class name;
- `@acme/ui/react` and `@acme/ui/vue`: each element as a React or Vue component, with two-way props, events and children working as through the plugin;
- typings for all of them, including the React and Vue component types;
- `custom-elements.json`, the [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest), referenced from `package.json`'s `customElements` field for IDEs, documentation tools and Storybook;
- `package.json` with `exports` for each of the above, and `@mnx/runtime` as a peer dependency.

`buildLibrary(dir, options)` from `@mnx/compiler/library` does the same from a script. `examples/frameworks/ui/` is one, built from the registry, and the React and Vue example apps import it like a package from npm.

**Start from the registry.** `npx mnx add tag-input` copies an accessible component from `registry/` into `src/components/`, and it's yours to change. There are twenty, from form controls to a modal dialog and charts, each tested from the keyboard and by role and accessible name. `npx mnx add --list` lists them; `registry/README.md` has the details and the theme properties.

**Storybook.** With `@storybook/web-components`, give Storybook the manifest and it fills each story's controls and docs (attributes, properties, events, slots, descriptions) from it:

```js
// .storybook/preview.js
import { setCustomElementsManifest } from '@storybook/web-components';
import manifest from '@acme/ui/custom-elements.json';   // or the manifest mnx writes for your own components
setCustomElementsManifest(manifest);

// quantity-stepper.stories.js
import '@acme/ui/quantity-stepper';
export default { component: 'quantity-stepper' };
export const Default = { args: { value: 2, max: 5 } };
```

## Moving in from React

`mnx convert` rewrites a React function component as an mnx JSX component next to it (`TodoItem.jsx` becomes `todo-item.mnx.jsx`, `<todo-item>`):

```sh
mnx convert src/TodoItem.jsx              # or npx mnx convert, from @mnx/compiler
mnx convert src/Counter.jsx --prefix app  # one-word names need a prefix: <app-counter>
mnx convert src/Menu.jsx --component MenuItem   # one of several exported components
mnx convert src/TodoItem.jsx --as mnx     # the HTML-first .mnx file instead of JSX (once nothing is left to finish)
```

The body of an mnx component runs once per element, so the hooks become what they stand for:

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

Preact's hooks (`preact/hooks`) convert the same way. Comments and formatting are kept, since only what changes is rewritten. What it can't convert, it reports, with advice, and it exits with status 1:
- custom hooks, a context created in another module, an exported context (a component file exports only its component), `<Context.Provider>`;
- props taken as one object rather than destructured;
- spread attributes and `dangerouslySetInnerHTML`.

`docs/convert-measured.md` runs it over shadcn/ui's 325 components: spread props block nearly all of them, which is the next thing to build.

The result is compiled as part of the conversion, and a compile error is shown at its place in the output. With `--out` in another folder, relative imports are adjusted to it.

`examples/frameworks/react-board/CONVERTED.md` walks through a real one: the board's card editor, converted from React, with what was finished by hand.

## Editors and tooling without Rust

- **`@mnx/compiler`** (`compiler/`) is the compiler built to WebAssembly, for Node: the same output and errors as the CLI, with no Rust toolchain. `@mnx/unplugin` uses it automatically when it's installed.
- **Editor support** (`editors/`): a language server (diagnostics as you type, completion, hover, go to definition) and a VS Code extension with syntax highlighting. See `editors/README.md`.
- **`--emit html-data`** writes VS Code HTML custom data, for completing mnx elements in plain `.html` files.

## Describing components to tools

- `--emit manifest` writes a [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest) (`custom-elements.json`, schema 2.1.0): the tag, each prop as an attribute and a field with its type and default, events with their `CustomEvent<…>` types, slots (the default slot is `""`) and the description. Editors, Storybook and documentation tools read this format. `--module-path` sets the module path it records.
- `--emit dts` writes TypeScript declarations: the element class with typed properties and typed `addEventListener`, a `…Props` interface, an `…EventMap`, the `tag` constant and an `HTMLElementTagNameMap` entry. `--framework react|vue` types the default export as that framework's wrapper, which is what the plugin writes.
- Types are inferred from defaults: `{ sample: "…" }` becomes `{ sample: string }`, `["a"]` becomes `string[]`, and a required prop with no default is `unknown`.

## Safety

Dynamic values are escaped or written as text. URL attributes must be relative or `http`, `https`, `mailto` or `tel`, checked at build time and again at runtime. Boolean attributes take booleans. String event handlers, inline styles, and `<script>`/`<style>` inside templates are rejected. See `docs/security.md` for the full model.

## The CLI

```sh
mnx check <component.mnx>... [--format human|json] [--server] [--stdin]
mnx migrate <component.mnx>... [--check]
mnx compile <component.mnx> [--emit html|js|css|dts|manifest|html-data] [--props <props.json>] [--slots <slots.json> [--slots-html]] [--partial]
                             [--runtime <module>] [--keep-imports] [--no-imports] [--framework react|vue|svelte|solid]
                             [--css-import <specifier> --css-import-inline <specifier>]
                             [--module-path <path>] [--output <file>]
mnx request < request.json
mnx serve
```

`mnx check` reports every error and warning in the given files without writing anything (exit status 1 on errors; `--format json` for editors and CI annotations; `--stdin` checks unsaved text as if it were at the one path given). It runs every check that doesn't need prop values, for both outputs. `--emit html` (the default) writes server-rendered HTML. `--emit css` writes the scoped stylesheets of a component and the components it imports (`--no-imports` for its own only). `--props` and `--slots` supply values (defaults come from the component); `--slots-html` reads the slots as server-rendered HTML, kept as written, and `--partial` leaves what only the browser can compute for the element. `--emit js` writes the element module: `--runtime` changes the runtime import (default `@mnx/runtime`), and `--keep-imports` leaves `./x.mnx` imports for a bundler (otherwise they become `./x.js`), and `--css-import <specifier> --css-import-inline <specifier>` imports the `<style>` through the bundler instead of inlining it. `--emit dts` writes declarations (`--framework` for a wrapper's) and `--emit manifest` the manifest. Output goes to stdout, or to `--output <file>` with an atomic write. Warnings go to stderr. `mnx check --server` also reports what a server without JavaScript leaves out (see "What the server can render"). `mnx request` takes one JSON request on stdin and writes the JSON response, the interface the WebAssembly build exposes (see `src/request.rs`). `{ "requests": [ … ] }` is a batch, answered as `{ "ok", "responses": [ … ] }`. `mnx serve` keeps running and answers one request (or batch) per line on stdin with one response per line on stdout, for servers in other languages that render often (`examples/backends/flask-garden/garden/mnx.py`).

## Standards

mnx is meant to be absorbed by the platform. These reports give the standards discussions evidence from using it:

- [`docs/standards/signals.md`](docs/standards/signals.md): an integration report for the TC39 Signals proposal, including two reference-polyfill behaviours the README rules out and the cost of unwatching one effect at a time.
- [`docs/standards/dom-parts.md`](docs/standards/dom-parts.md): what a parts model needed in practice (markers, regions, hydration), for DOM Parts and declarative templating.
- [`docs/standards/declarative-custom-elements.md`](docs/standards/declarative-custom-elements.md): the `.mnx` format as a worked declarative custom elements explainer.
- [`docs/standards/one-source-n-consumers.md`](docs/standards/one-source-n-consumers.md): the case for one source against agent-made ports, with numbers: what the compiler generates for the registry across the matrix, the ten framework bugs the adapters absorbed once, and an experiment where an agent ported three components to three frameworks (47 behavioural differences before any change; a fix propagated to all six ports without error).
- [`docs/framework-matrix.md`](docs/framework-matrix.md): what each framework's row in CI proves, and what isn't in a row.

## Stability

3.0 freezes, until 4.0:
- the authoring formats (`.mnx`: script semantics, host tag and flags, `{expr}`, directives, slots, keys, imports, `emit`; JSX components);
- the CLI's commands and options, and the outputs' behaviour;
- the runtime's documented exports.

The generated JavaScript's internal shape (`$define()`'s arguments, parts) is not public API. It is versioned (`abi`): a runtime refuses modules compiled for another major version with an error that says to recompile, instead of misbehaving.

**Upgrading from 2.x.** The one 3.0 change that touches code: a signal `const` in a script means its value, as it already did in templates. `count.get()` and `count.set(…)` keep working, so only a signal passed as itself (`watch(count, …)`, `formValue(count)`) changes meaning. Run `mnx migrate --to 3` once, on the 2.x code: it wraps those in `signal(count)`, which means the signal in 2.x and 3.0 alike. The CLI's 1.x name, `mnix`, is gone. Compiled code is unchanged (`abi: 2`), so 2.x builds run on the 3.0 runtime. See `docs/migrating-to-3.0.md`.

Upgrading from 1.x: `mnx migrate` rewrites what 2.0 needs; see `docs/migrating-to-2.0.md`. Browser support: `docs/browser-support.md`. Planned after 2.0: streaming server rendering (sending resolved `mnx-await` content as it arrives).

## Repository and tests

- `src/`: the compiler (Rust): scanner, parser, script analysis with oxc, resolver and lowering, HTML renderer, JavaScript and interface emitters, CLI.
- `runtime/`: `@mnx/runtime`, with the React, Vue and Angular adapters and the server registry.
- `plugin/`: `@mnx/unplugin`, with the Astro integration.
- `compiler/`: `@mnx/compiler`, the compiler as WebAssembly; `wasm/` is its Rust shim.
- `editors/`: the language server and the VS Code extension.
- `create/`: `create-mnx`, the starter (`npm create mnx`), with a template per framework.
- `playground/`: the in-browser playground, published to GitHub Pages by `.github/workflows/pages.yml`.
- `docs/guide/`: the tutorial.
- `docs/who-this-is-for.md`, `docs/what-crosses-the-boundary.md`, `docs/server-rendering.md`: where mnx fits, which components fit through an element, and the server story with its gaps.
- `registry/`: the components `mnx add` copies, with their accessibility tests.

Install Rust 1.97 or newer and Node 20 or newer.

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
(cd runtime && npm ci && npm test)       # unit tests, incl. Signals differential tests
(cd runtime && npm run test:browser)     # Chromium: components, hydration, slots, events, adapters, leaks, benchmarks
(cd runtime && npm run test:tools)       # manifest schema, TypeScript checks, size budgets
(cd plugin && npm ci && npm test)        # real apps: React, Vue, Svelte, Solid, Lit, Astro, Tailwind; Rollup, webpack, esbuild
(cd compiler && npm test)                # render API (and, with mnx.wasm built, parity with the CLI)
(cd create && npm test)                  # the starter's command line
node --test "registry/test/*.test.js"    # the registry's components: keyboard and screen-reader behaviour
(cd examples/frameworks && npm ci && npm test)  # the framework apps, and every starter's own browser test
node --test "playground/test/*.test.js"  # the playground in Chromium
```

The browser and plugin suites need Playwright's Chromium (`npx playwright install chromium`). `.github/workflows/ci.yml` runs every suite on each push. Behaviour is mutation-checked: each feature's code was deliberately broken in turn to confirm a test fails.

## License

ISC. See `LICENSE`.
