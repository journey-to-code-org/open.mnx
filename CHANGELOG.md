# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): from 1.0.0, the authoring formats, the CLI and the runtime's public API change incompatibly only in a new major version.

## 2.6.4 — 2026-11-07

### Examples

- **`examples/backends/flask-garden/`**: a community garden's plot sign-up in Python, built with Flask, Jinja and SQLite.
  - Its components are rendered by the mnx CLI (`mnx request`), so there's no Node.js on the server and no bundler. The browser hydrates them through an import map.
  - `garden/mnx.py` is the glue: about 100 lines, standard library only.
  - Every page works without JavaScript. Its tests drive them in Chromium with JavaScript off and on, using Playwright for Python. CI runs them in a new `backends` job.
  - Its README lists what it found about the server's expression subset, which is everything a non-JavaScript server has.

## 2.6.3 — 2026-11-07

### Fixed

- **An empty URL prop no longer logs an unsafe-URL error.** A URL attribute bound to a prop whose default is `""` (`href={href}` before the app sets it) is now left off quietly.
- **An object prop written as `"[object Object]"` is treated as not given yet.** Svelte's server rendering writes object props that way. The element now uses the prop's default until Svelte sets the real object, instead of warning about invalid JSON.
- **Library mode's React entries start with `'use client'`,** so React Server Components (Next.js) can import them.

### Examples

- **`examples/meta/`**: three meta-framework apps, each with a Chromium test in CI.
  - `next-conference/`: Next.js 16 with the App Router. Components come from a library built with `mnx build --lib`, since Turbopack takes no bundler plugins. Feedback is posted through a Server Action with `useActionState`.
  - `nuxt-bookshop/`: Nuxt 4 through the Vite plugin, with `v-model` on mnx controls and Nitro API routes.
  - `sveltekit-workouts/`: SvelteKit 3 through the Vite plugin, with mnx form controls in a form action using `use:enhance`.

  Their components use shadow DOM. Light-DOM components conflict with the frameworks' hydration today. That finding, and the others, are written up in `examples/meta/README.md` and planned in `plan/roadmap-server.md` (2.7 and 2.8).

## 2.6.2 — 2026-11-07

### Examples

- **`examples/helpdesk/`**: a help-desk ticket tracker built with Express, EJS and MongoDB. Its mnx components are rendered on the server inside EJS pages (with `@mnx/compiler`), and the browser hydrates them in place without a bundler. Every page works with JavaScript off, because the components render native form controls in light DOM. With JavaScript on, they add keyboard navigation, live filters, a smarter reply box and running SLA timers. The dashboard charts came from the registry with `mnx add`. Its tests drive every page in Chromium with and without JavaScript, and check the store contract. CI runs them on the in-memory store and on a MongoDB service container.

## 2.6.1 — 2026-11-07

### Fixed

- **The React adapter sets props before the component's script runs** (React 19). It used to set them after React inserted the element, so a script that seeds state from a prop (`let draft = card`, which is what `mnx convert` makes of `useState(card)`) saw `undefined`. React 19 now sets them as it creates the element. Under React 18 the script still sees the default.
- **`mnx convert --out` into another folder** adjusts the output's relative imports to it.

### Examples

- The React board and the Vue budget take their shared components from a library, `examples/frameworks/ui/`, built from the registry with `mnx build --lib`. They import it like a package from npm (`@mnx-examples/ui/react`, `@mnx-examples/ui/vue`). Their app-specific components stay `.mnx` files compiled by the plugin.
- The React board's card editor was converted from React with `mnx convert`. `react-board/CONVERTED.md` has the before and after, and what was finished by hand.

## 2.6.0 — 2026-11-07

Move in, and the 3.0 runway (`plan/roadmap-adoption.md`). The last release of the adoption roadmap.

### Added

- **`mnx convert <Component.jsx>`** rewrites a React (or Preact) function component as an mnx JSX component:
  - `useState` → `let`, with setter calls as assignments;
  - `useMemo` and `useCallback` → plain `const`s;
  - `useRef` → a `let` without `.current`;
  - `useEffect(fn, [])` → `onMount(fn)`, and `useEffect(fn, deps)` → `onMount(() => effect(fn))`, which keeps React's after-render timing;
  - `onChange` on text fields → `onInput`, and `onDoubleClick` → `onDblClick`;
  - a single named export becomes the default export.

  Only what changes is rewritten. What it can't convert (other hooks, props not destructured, spread attributes, `dangerouslySetInnerHTML`) is reported with advice, and the output is compiled to check it. A converted component is tested in Chromium against its React behaviour. It's also available as `npx mnx convert` and through the request interface (`command: "convert"`).
- **Preparing for 3.0** (`plan/decisions/3.0-scope.md`). In 3.0, a signal `const` in a script will mean its value, as in templates. `.get()` and `.set()` keep working, so only a signal passed as itself changes meaning.
  - `mnx check` (and editors) warn at each such place.
  - `mnx migrate --to 3` wraps them in `signal(…)`, new in `@mnx/runtime` as the identity, which means the signal in 2.x and 3.0 alike.
- **The adoption check** (`scripts/adoption-check.mjs`, run in CI): `npm create mnx` → `mnx add` → an edit → `mnx check` → the app's browser test → `mnx build --lib` → `npm pack`, timed against a 10-minute budget. It takes under two seconds of tool time, not counting dependency installation.

## 2.5.0 — 2026-11-07

Share components (`plan/roadmap-adoption.md`).

### Added

- **Library mode: `mnx build --lib <dir>`.** A folder of components becomes a publishable package with no bundler or mnx tooling needed by consumers. It contains an ES module per element, an index, React and Vue entries (`<package>/react`, `<package>/vue`) with their typings, `custom-elements.json`, and `package.json` exports. Tested by building the registry and using it from a React app and a Vue app (each with only its framework's Vite plugin), a plain page and TypeScript.
- **`mnx` on npm**: `@mnx/compiler` now has a command, `mnx`, with `build --lib`, `add`, `compile` and `check`, running the WebAssembly compiler (no Rust needed). `buildLibrary()` is exported from `@mnx/compiler/library`.
- **The component registry: `mnx add <name>`.** It copies one of twenty accessible components into your project (`--dir`, `--force`, `--list`). They are drawn from the examples:
  - inputs: tag input, date range, money input, star rating, toggle switch, choice cards, colour swatches, quantity stepper, segmented control;
  - display: donut chart, spark line, line chart, progress ring, streak grid, flip card, step indicator;
  - app pieces: kanban column, chat message, message composer, and a new modal dialog.

  Each has keyboard and screen-reader tests (role, accessible name, announced state). Every colour is a themeable custom property with a default.
- **Storybook through the manifest**: the library's `package.json` points to its `custom-elements.json`, which `@storybook/web-components` reads for controls and docs (README, "Sharing components").

### Fixed

- The chat message's action toolbar (the Lit example's, and the registry's) was `display: none` until hovered, so the keyboard couldn't reach it. It is now transparent until hovered or focused.
- In the registry versions: the star rating is a named group with a two-way `value`; the spark line is an image named with its trend; the flip card's name is its visible face; the emoji picker is a named group rather than a menu without menu keys.

## 2.4.0 — 2026-11-07

Start in a minute (`plan/roadmap-adoption.md`).

### Added

- **`npm create mnx`** (`create/`, the `create-mnx` package). It asks for a framework (none, React, Vue, Svelte, Solid, Preact, Lit, Angular or Astro) and writes a working app: one component, the plugin wired up, typings, and a browser test (`npm test`). CI writes every starter and runs its own test.
- **Hot reloading that keeps state.** In Vite's dev server, an edited component is swapped into the live elements, which keep their props, state and slotted content (light and shadow DOM). A change to the element's interface reloads the page instead.
- **Compile errors in Vite's overlay**, with the location, the code frame and the compiler's suggestion.
- **The playground** (`playground/`): the WebAssembly compiler in the page, the component running in plain HTML, React and Vue side by side, the JavaScript, server HTML, typings and manifest in tabs, and the example in a shareable link. Published to GitHub Pages by `.github/workflows/pages.yml`.
- **The guide** (`docs/guide/`): a seven-step tutorial from a first component to server rendering, and pages for React, Vue and Svelte developers. The README is now the reference.
- **Runtime messages link to the docs**: slot, hydration, list-key, hook, form and URL-safety warnings and errors name the README section that explains them.

### Changed

- `@mnx/unplugin` dedupes Angular's packages too, as it does React and Vue, so a linked `@mnx/runtime` doesn't bring a second Angular.
- The runtime is 12.0 KB gzipped (hot reloading and the doc links), within its 12 KB budget.

## 2.3.0 — 2026-11-07

Components that say less (`plan/roadmap-adoption.md`). Rewritten with these, the example components went from 1,913 lines to 1,882, with no hand-fired `<prop>change` events (was 11) and 6 `.get()` calls left of 30 (`node examples/stats.mjs`).

### Added

- **Two-way props**: `value:model={0}` on the host. Assigning the prop in the script fires `valuechange` when it changes; the event is declared in the typings (`CustomEvent<number>`) and the manifest. In JSX, a default of `model(x)`.
- **Automatic form values**: a `form-associated` control with one `:model` prop and no `formValue()` submits that prop, and a form reset restores its initial value.
- **Signals read like values in templates**: a `const` from `state()`, `computed()`, `inject()` or `hasSlot()` is unwrapped where the template reads it (`{user.name}`), and a `const` derived from one is a computed.
- **`hasSlot(name)`**: a signal saying whether a slot has content, following it in light and shadow DOM.
- **`declare const name: Type`** types a prop in `<script lang="ts">`; one naming no prop is an error, with a suggestion.

### Changed

- The runtime's size budget is 12 KB gzipped (was 11 KB); it is 11.4 KB.

## 2.2.0 — 2026-11-07

Templates that say less (`plan/roadmap-adoption.md`). Rewritten with these, the example components went from 1,968 lines to 1,913, with no class-string concatenation (was 22), no `host()` queries (6), no hand-added window or document listeners (2), and 4 `preventDefault()` calls left of 18 (`node examples/stats.mjs`).

### Added

- **`class:` and `style:` directives**: `class:open={…}` (bare `class:open` reads `open`), `class={{ … }}`, `style:font-size={…}`, `style:--tone={…}` and `style={{ … }}`. Merged into `class` and `style` in the HTML output; bound one class or property at a time in the browser. A computed `class` beside toggles is bound token by token. Static `style="…"` attributes are now allowed.
- **Event modifiers**: `.prevent`, `.stop`, `.once`, `.self`, `.capture`, `.passive`, and key filters (`onkeydown.enter`, `onkeydown.shift.arrowleft`, `onkeydown.k`) with exact modifier keys. Unknown modifiers get a suggestion.
- **`ref={name}`**: the element, assigned to a `let` (or passed to a function), and `null` when it's removed. Also in JSX.
- **`<mnx-window>` and `<mnx-document>`**: event listeners on the window or document while rendered.
- **`<mnx-else-if test={…}>`**.
- **`prevent`, `stop`, `selfOnly` and `keys`** in `@mnx/runtime`: the modifiers as functions, for JSX and scripts.
- **Object shorthand** in template expressions: `{ open }` means `{ open: open }`.
- **`examples/stats.mjs`**: the scoreboard each release reports.
- The VS Code grammar highlights modifiers, directives and `ref`.

## 2.1.0 — 2026-11-07

### Added

- **An app per framework** in `examples/frameworks/`: a sprint board (React), a budget tracker (Vue), a flashcard trainer (Svelte), a live market dashboard (Solid), a team chat (Lit), a habit tracker (Preact) and a booking wizard (Angular). Each mixes the framework's own components with mnx elements, and a new CI job builds every one and uses it in Chromium.
- **Angular in Vite**: with Analog's plugin, `.mnx` files are imported directly and `MnxModel` compiles ahead of time. Its typings now carry Angular's directive declaration, which ahead-of-time compilation needs (the Angular CLI included). The adapter file moved to `fesm2022/`, as the Angular Package Format lays out, so Vite-based Angular builds link it; `@mnx/runtime/angular` is unchanged.
- **Light-DOM styles in other libraries' shadow roots, through a bundler.** With `@mnx/unplugin`, a component's CSS went into the page only, so an mnx element inside a Lit component's shadow root (or any other) was unstyled. The CSS text now comes along, and is adopted into shadow roots; the page keeps the bundled stylesheet.

### Fixed

- Rows and branches of `mnx-each`/`mnx-if` inside `<svg>` (or `<math>`) were created as HTML elements, so they didn't render. They're now parsed in their parent's namespace.
- The Vue adapter set props as Vue DOM props, where Vue turns `null` into `0`, `''` or `false` (by the property's current type). Props are now set by a directive, as given.
- An invalid form-associated component made the browser log "An invalid form control … is not focusable" when a form reported validity: the message was anchored to the host. It's now anchored to the first focusable element the component rendered, which the browser focuses.
- Bound `value` isn't written when the text is already the same, which moved the caret and lost a selection.

## 2.0.2 — 2026-11-07

### Added

- **An event planner example** (`examples/planner/`): a single-page app in nine `.mnx` components. It has a month calendar, a searchable list, a dialog form, and per-event schedule, guests, budget and tasks, plus `.ics` export. It uses context, hash routing and `localStorage`, and the plugin's tests use all of it in Chromium.

### Fixed

- A `<select value={…}>` whose options come from an `mnx-each` inside it showed its first option: the value was set before the options existed. It's now set again once they do.

## 2.0.1 — 2026-11-06

### Added

- **Example projects** in `examples/`: a to-do list (Vite, two `.mnx` components) and a recipe site (Astro: static components, a JSX island, a form-associated star rating, reviews loaded with `resource()`). Both are built and used in Chromium by the plugin's tests.

### Fixed

- An element that a list row inserted stopped working once the list changed again: its effects belonged to the list's effect and were disposed with it. Each element now owns its own effects.
- `value={…}` and `checked={…}` on form controls are set as the live property, so `draft = ""` clears what the user typed; the property is written only when the bound value changes, so typing isn't overwritten.
- Rows that a light-DOM component's own `mnx-each` added after the first render could be dropped: they were moved through the host's slot routing (meant for content a framework adds) instead of the native DOM methods.

## 2.0.0 — 2026-11-06

mnx leans on the platform more and on itself less, and `.mnx` scripts mean what JSX components already did. Upgrading: `mnx migrate`, then see `docs/migrating-to-2.0.md`.

### Changed (breaking)

- **Props are names in the script.** `value` reads the prop and `value = 2` sets it, as in the template; `props()` stays for custom hooks. A script can no longer declare a name a prop has (the 1.x `title={title}` default pattern), which is an error that points at `mnx migrate`.
- **A top-level `let` is state.** Assigning it (`count++`, `count = 0`, `count += 2`, in the script or in an inline handler) updates what reads it. A top-level `const` that reads props or state is derived, so it stays in sync. Initial values still render on the server, and script values that read props are now evaluated with the props' values there.
- **The CLI is `mnx`** (crate `mnx-compiler`). `mnix` stays as an alias through 2.x.
- **Compiled code is versioned.** Modules call `$define()` with `abi: 2`; `define` (what 1.x modules call) throws an error that says to recompile, and so does a module for another interface. `$define`, `$r` and `$t` are internal.
- Tools look for `mnx` on PATH first, then `mnix`.

### Added

- `docs/browser-support.md`: the Baseline 2025 target, what each newer feature is used for, and what happens without it.

### Unchanged

- The hydration markers. DOM Parts hasn't settled on a serialization (see `docs/standards/dom-parts.md`), so 2.0 keeps 1.x's.
- The Signals API, which hasn't changed since mnx adopted it.

## 1.7.0 — 2026-11-06

The runway to 2.0: everything 2.0 changes for `.mnx` files now warns, with a migration tool. See `docs/migrating-to-2.0.md`.

### Added

- **`mnix migrate <files…> [--check]`**: rewrites `.mnx` files for 2.0. A script binding that shares a prop's name (the `title={title}` default pattern) is renamed, with its uses in the script and in host defaults. It also lists `let`s that will start updating the template. `--check` only reports, and fails if anything would change.
- **Deprecation warnings** (in `mnix check`, the plugin and the language server): a script binding that will clash with a prop in 2.0, and a `let` the script changes and the template reads.
- **The `mnx` binary**, the CLI's 2.0 name, installed alongside `mnix`.

## 1.6.0 — 2026-11-06

### Added

- **Leak suite**: removed elements, including ones React and Vue unmount and ones that read a signal that outlives them, are garbage-collected. Checked in Chromium by counting live instances through the DevTools protocol.
- **Benchmarks**: the js-framework-benchmark operations on 1,000 keyed rows, and hydration against fresh rendering, with budgets that catch quadratic operations and hydration that re-renders.
- **Size budgets**: the runtime, the Signals implementation included, within 11 KB gzip (9.7 KB).
- **Standards write-ups** in `docs/standards/`: a Signals integration report, a parts usage report for DOM Parts and declarative templating, and the `.mnx` format as a declarative custom elements explainer.

### Fixed

- Clearing or replacing a long list was quadratic: each removed row unwatched its effects separately. A subtree now unwatches in one pass, so clearing 1,000 rows went from 112 ms to 28 ms and replacing them from 118 ms to 46 ms. New rows are built in one fragment and inserted once.

## 1.5.0 — 2026-11-06

### Added

- **`resource(fetcher)`**: async data as signals (`value`, `error`, `status`, `loading`, `refresh()`, awaitable). The fetcher re-runs when what it read changes. A new run, or the element's removal, aborts the previous one through its `AbortSignal`, and late answers are dropped.
- **`<mnx-await value={…}>`** with pending content, `<mnx-then as="…">` and `<mnx-catch as="…">`. Only the latest value's outcome shows, and a `resource()` is followed through its states. On the server, a value known at build time renders `mnx-then`; otherwise the pending content is rendered in a region the element renders when the value settles.
- **Partial server rendering** (`--partial`, request `partial: true`): what only the browser can compute is left for the element. Text renders empty, attributes are left out, and conditionals and lists render as empty `<!--[?-->` regions, which the element renders without a hydration warning. `@mnx/compiler`'s `render()` and the plugin's server builds render partially, so every component server-renders, including JSX components with state, in Astro too.

### Changed

- Streaming server rendering moves from 1.5 to after 2.0. Partial rendering and `mnx-await` cover sending the shell first.

## 1.4.0 — 2026-11-06

### Added

- **JSX components** (`.mnx.jsx` / `.mnx.tsx`): a function component compiles to the same custom element as an `.mnx` file. The function's name is the tag, destructured parameters are props, `on<Name>` parameters are events (`onValueChange(x)` fires `valuechange`), `children` is the default slot, a top-level `let` is state, and a top-level `const` that reads props or state is derived. `&&` / `? :` are conditionals and `.map()` with a `key` is a keyed list. It's lowered to the `.mnx` format with a source map, so every output and check works and errors point into the JSX. `.mnx` and JSX components import each other, and `@mnx/unplugin` resolves `.mnx.jsx` / `.mnx.tsx` imports with the same variant rules.
- **JavaScript expressions in templates**: beyond the build-time subset, any expression is accepted as code that runs in the browser: calls, arrow-function handlers that close over list items, list methods. Names follow the script (a `state()` is read with `.get()`), only props can be assigned, `emit()` in a template declares its event, and a runtime expression can be a prop default. The HTML output reports these as browser-only, as it does runtime-only script values.

## 1.3.0 — 2026-11-06

### Added

- **Server rendering for apps.** `@mnx/compiler` has `render(path, { props, slots })` (HTML plus the scoped CSS it needs) and `renderToString()`, throwing a `CompileError` with diagnostics. Compiled modules now load on a server: without a DOM, `define()` returns a stand-in that carries the element's `mnx` description, so adapters and framework SSR can import components. `@mnx/runtime/server` renders an element class (`renderToString(Element, { props, attributes, slots })`), and the plugin's server builds register each component's renderer, with its sources embedded.
- **Astro integration** (`@mnx/unplugin/astro`): `.mnx` components in Astro pages, server-rendered, static by default and hydrated with `client:*` directives. Props go to the component, other attributes to the host, children to slots.
- **Slot content as server HTML.** Slots can be HTML a server already rendered, kept as written: braces are text, and comments (hydration markers), `<script>`, unquoted and inline-handler attributes stay. Request `slotSource: "html"`, CLI `--slots-html`; `render()` uses it by default. Slotted elements are still marked for scoped styles.
- **Angular**: `MnxModel` from `@mnx/runtime/angular`, a standalone directive that makes an mnx element a form control (`ngModel`, `formControl`, `formControlName`) through its `<prop>` + `<prop>change` pair, with touched and disabled states. Published as partial declarations, so the Angular linker compiles it for AOT builds.
- **Svelte, Solid and Lit**: the plugin detects Solid, Preact and Svelte projects and gives their files the element itself; `--framework svelte|solid` typings (`svelte/elements`, Solid's `prop:`/`on:`). Tested in real apps, with Lit as a host too.
- **`mnix request`**: one JSON request on stdin, the response on stdout (what the WebAssembly build exposes). `@mnx/compiler` uses it when `mnx.wasm` is missing and `$MNX_COMPILER` names a native `mnix`.
- The plugin is tested building with Rollup, webpack and esbuild as well as Vite.

### Fixed

- Light-DOM slots keep a framework's markers with its content (a comment goes with the content after it, whitespace with the content before it), so Lit's parts and Svelte's anchors stay in one slot. Markers and whitespace alone don't fill a slot.
- The plugin found `.mnx` imports in `<script lang="ts">` too when watching a component's dependencies.

## 1.2.0 — 2026-11-06

### Added

- **`@mnx/compiler`**: the compiler as WebAssembly (`mnx-wasm`, a C-ABI shim over the new `handle_request`: a JSON request with every source in, a JSON response with output and diagnostics out). Same output as the CLI, checked by a parity test in CI. `@mnx/unplugin` uses it when no CLI is configured, so apps need no Rust toolchain.
- **`@mnx/language-server`**: diagnostics as you type, completion (directives, imported components, props, events, props in expressions), hover docs and go to definition, over LSP.
- **VS Code extension** (`editors/vscode`): TextMate grammar with embedded JavaScript/TypeScript/CSS/SCSS, language configuration, and the language server.
- **`--emit html-data`**: VS Code HTML custom data for mnx elements in `.html` files.
- **`mnix check --stdin`**: checks unsaved text as if it were at the given path.

## 1.1.0 — 2026-11-06

### Added

- **`mnix check`**: every error and warning in the given files, without writing output; exit status 1 on errors; `--format json` for editors and CI.
- **Scoped `<style>`**: light-DOM styles use native `@scope` and stop at slotted content, marked `data-mnx-slotted="<component>"`; shadow components adopt a shared sheet, with a `<style>` in their declarative shadow root for server rendering. Styles sit in the `components` cascade layer with Tailwind's layer order declared, so utilities and page CSS override them (`layer="…"` / `layer="none"` to change that). `:host` works in both modes. `--emit css` for the page; with `@mnx/unplugin`, `<style>` (including `lang="scss"`) goes through Vite's CSS pipeline, so Tailwind's `@apply` and `@reference` work. `adoptStyles()` brings app-wide CSS into shadow roots.
- **Prop defaults computed in the browser**: a default that uses runtime-only script values (or the browser's globals) is computed per element after the script runs, unless the prop was given. The HTML output asks for it via `--props` or the parent.
- **`<script lang="ts">`**: TypeScript component scripts, erasable syntax only, with types removed in place so positions are kept. Annotated bindings type the props they default, `emit<T>()` types event details, and the script's types are exported from the generated typings.

### Fixed

- The JavaScript output now checks how child components are used, as the HTML output does: unknown props (with suggestions), literal values of the wrong type, missing required props, and listeners for near misses of a child's events.
- A script binding that reads a browser global (`window`, `document`, `Math`, …) is runtime-only instead of an "used before it is declared" error.

## 1.0.0 — 2026-11-06

The first stable release: the `.mnx` format is frozen until 2.0, and both outputs support everything in it. Covers the compiler crate and CLI (`mnix`), `@mnx/runtime` and `@mnx/unplugin`. Licensed under ISC.

### Format

- **Single-file components.** An optional `<script>`, then a host tag that declares the custom element and its props: `title={title}` takes its default from the script, `label="Hi"` is a string default, a bare `name` is required. `shadow` opts into shadow DOM; `form-associated` makes the element a form control. A comment above the component is its description.
- **`{expr}`** in text and attributes, in a JavaScript subset with JavaScript's semantics (`?.` `??` `? :`, strict `==`, truthiness). Every name is checked in every branch, with "did you mean" suggestions.
- **Directives**: `mnx-if` / `mnx-else`, `mnx-each` (with `index` and `key`), `mnx-slot` (named, with fallbacks).
- **Templates may have any number of top-level nodes**: the host is the root.
- **Components using components**: `import './badge.mnx'` in the script; props are type-checked at the call site.
- **Events inferred from `emit("name", detail)`**, named like the platform's events (lowercase, no separators), with `@fires` documentation checked against the code.

### Outputs

- **HTML** (`--emit html`, the default): static, deterministic, escaped markup with the markers the runtime needs to hydrate it; child components rendered inline (declarative shadow DOM for shadow components). `--props` and `--slots` supply values.
- **JavaScript** (`--emit js`): a custom element on `@mnx/runtime`. Signal-backed props and typed attributes; template parts that bind to server markup without re-rendering (after a shape check); regions for `mnx-if` / `mnx-each`, with keyed rows moved by `moveBefore()`; light-DOM slots that stay live under frameworks managing the element's children; native `<slot>` in shadow components; pause on detach.
- **Custom Elements Manifest** (`--emit manifest`, schema 2.1.0) and **TypeScript declarations** (`--emit dts`, optionally `--framework react|vue`).
- **Warnings** for props that shadow built-in element properties (`hidden`, `title`, …).

### Runtime (`@mnx/runtime`)

- The TC39 Signals API (the browser's own when present), differential-tested against the proposal's reference polyfill; batched effects with ownership.
- Hooks: `state`, `computed`, `effect`, `watch`, `onMount`, `onUnmount`, `id`, `props`, `host`, `emit`; context on the Web Components Community Group Context Protocol (`createContext`, `provide`, `inject`); form controls on `ElementInternals` (`formValue`, `validity`, `onFormReset`, `onFormRestore`, `onFormDisabled`).
- Adapters: `@mnx/runtime/react` (React 18 and 19) and `@mnx/runtime/vue` (Vue 3), with two-way binding from `<prop>` + `<prop>change` pairs.
- Type declarations for every entry point.

### Build plugin (`@mnx/unplugin`)

- Compiles `.mnx` imports in Vite, Rollup, webpack, esbuild and Rspack. The importing file decides what it gets: a React component, a Vue component, or the element class. Typings are written next to each component.

### Changed from 0.2

- The `component:` / `prop` / `---` header, `{{ … }}` and the `mnix-` directives are replaced; see `docs/migrating-from-0.2.md`. The compiler rejects each old form with a hint.
- The minimum Rust version is 1.97 (required by the oxc JavaScript parser).

## 0.2.0 — 2026-09-30

- Compile-time `mnix-if` / `mnix-else`, `mnix-each` over string lists, and default and named slots with fallbacks; `--slots` input.

## 0.1.0

- Static compiler: component header with typed props, one-root templates, escaped interpolation, URL safety, source diagnostics, atomic `--output`.
