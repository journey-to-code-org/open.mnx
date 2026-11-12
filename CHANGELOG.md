# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): from 1.0.0, the authoring formats, the CLI and the runtime's public API change incompatibly only in a new major version.

## Unreleased

### Added

- **Reads after an `await` in a resource's fetcher are followed (experimental).** A fetcher's code after its first `await` runs outside the effect, and the Signals API records a read only while a Computed runs, so `resource(async () => { const token = await auth(); return load(page, token) })` didn't load again when `page` changed. `tracked(fetcher)`, from the new `@zubra/runtime/track` (about 570 B gzipped, loaded only where it's used), gives each run `track(read)`: the read is followed, and a change runs the fetcher again. In a `.zb` script the compiler writes it for an async fetcher of the runtime's `resource()`: `$run.track(() => …)` around the props and state it reads that can run after the first `await` (in a loop that awaits, or in a function inside it, too), leaving the earlier reads plain. A replaced run, a run that has settled (a timer it left) and a disposed resource still read, without subscribing, and a detached element holds none of the reads. Reads the compiler can't see (a getter in another module) still need `track()`. The AsyncContext alternative was measured too; `docs/standards/signals.md` reports both.

## 5.8.0 — 2026-11-12

Zubra ready for the business kit, and Zubra beside other frameworks. For the kit: Sync's documents are a synchronous store with a key prefix, Actions take files, `class:` and `style:` work on child components, and a device offline for hours (or one whose tab closes mid-write) never loses its edits or shows an older change over them. Beside other frameworks: context and signals shared with the app, form libraries, the app's router, experimental React outlets, testing through every framework, a no-build `--embed` output, an MCP server for coding agents, and server templates for Django, Rails and Laravel. Also in this release: TypeScript enums (as prop types, from attributes and from other modules), `::slotted()` and `::part()` in light DOM, components and pages that ship no JavaScript when they need none, the ES2019–ES2024 array and object methods on the server, and a type-only import no longer reaching the browser.

**One behaviour change:** Actions now read a post only up to `maxBytes`, 10 MB by default. A bigger post gets `{ error: 'Too large' }` and the function doesn't run; set `createActions({ maxBytes: Infinity })` for the old behaviour.

### Added

- **`id()` renders on the server.** `const inputId = id()` used to be computed only in the browser, so a server-rendered `<label for>` and its `<input id>`, and every `aria-labelledby`/`aria-describedby`/`aria-controls`, pointed at nothing until JavaScript ran. Now each host gets an id base on the server (its own `id`, or `<tag>-s<n>` in document order, written as `data-zb-id`), each call its number, and the element uses the same base, so hydrating keeps the ids. Elements made in the browser count their own ids, which can't collide with the server's. `@zubra/server` prefixes each `page.render()` after the first (`r2-`) and each host it fills in framework HTML (`h1-`); `idPrefix` on a request does it elsewhere. It applies when every `id()` call is a `const x = id()`. In the registry, date-range, dropdown-menu, tag-input and tool-tip now have no parts left for the browser, and modal-dialog one instead of three. After Enhance's `instanceID`.
- **`page.provide()` in `@zubra/server`: context for a whole page.** `page.provide({ module: './theme.js', export: 'theme' }, 'dark')` provides a context to every component the page renders after it, as a component above them would, so the account, the locale or a theme doesn't have to be passed to each `page.render()` (Enhance's store, as context). They render with it and their elements start from it; a `<zb-context>` around the page changes it later. A render request takes the values as `context` (context key → value). And `@zubra/server` now serves the plain `.js` modules components import from the components folder (a module with the `createContext()`, a helper), which were a 404, with no way out of the folder.
- **Context renders on the server.** A component's `provide(context, value)` now reaches `const x = inject(context)` in the components it renders, in the server's HTML (it was empty until JavaScript ran): the nearest provider wins, a provider's own `inject` sees the one above, and with no provider the server uses the context's default when it can read the module. Contexts are matched by their module and export name. The consumer's host carries the values (`data-zb-inject`), and `inject()` starts from them, so hydrating doesn't flash the default before the provider answers. After Enhance's `state.context`.
- **Sync: `documents().all(collection, prefix)`** gives only the documents whose key starts with `prefix` (`all('seats', 'show-12/')`), as `scope` does for pages. With it, `documents()` and `write()` are a synchronous store in a few lines, for code that keeps its rules apart from where documents live: reads with no `await`, and a write in the documents before its promise settles. Documented, and tested on each log and inside a Durable Object, including after an eviction.
- **Actions: files, and a limit on what a post may be.** A file input reaches a server function as a `File` on both paths (documented and tested in a browser, with and without JavaScript). `createActions({ maxBytes })` caps a post, files and fields together, at 10 MB by default: a bigger one gets `{ error: 'Too large' }` (413), isn't kept (the rest is discarded as it arrives, so a browser still sending gets the answer), and the function doesn't run. **Before, a post of any size was read into memory**; set `maxBytes: Infinity` for that. For listing photos, logos and damage reports.
- **`::part()` reaches into light-DOM children.** A rule like `zb-meter::part(label)` in a component that imports a light-DOM `<zb-meter>` is rewritten to `@scope (zb-meter) to ([data-zb-slotted]) { [part~="label"] { … } }`, so it styles the child's own elements with that part (several names need all of them, as in shadow DOM) and stops at content slotted into the child. A shadow-DOM child, or a tag the compiler doesn't know, keeps the real `::part()`. In a light-DOM component's stylesheet those real `::part()` rules now go outside its `@scope`, as `:where(tag) child::part(x)` (WebKit doesn't match `::part()` inside `@scope`); `zubra convert` reads all of it back. It works in both a light and a shadow parent, in server HTML before JavaScript, and in plain elements. Browser test, mutation-checked.
- **Components that need no JavaScript, and pages that ship none for them.** The compiler now works out whether a component needs its module in the browser at all: it doesn't when it only shows its props and slots (no state, handlers, two-way props, lifecycle hooks, browser imports, `zb-await`, motion, or values the server can't compute, in it or in the components it uses). `zubra check --client` prints the answer and the reasons for each file, the interface (`--emit interface`, and `describe(name)` in `@zubra/server`) has them as `client`, and a check request takes `"client": true`. `createZubra({ clientModules: 'needed' })` in `@zubra/server` then leaves those components' modules out of a page: they're complete as server HTML, styles included. It's opt-in, since a page that changes such a component's props from its own script still needs the module. In the registry, progress-ring and spark-line need none. From Enhance's "elements first".
- **A warning for camelCase attributes that HTML lowercases.** `<star-meter maxvalue="8">` on a component whose prop is `maxValue` is ignored by the element (its attribute is `max-value`). `zubra check` and `zubra compile` now warn about it in `.zb` templates, with the fix, and in a page, where the browser lowercases `maxValue` itself, the element warns in the console once, naming the attribute to write. Plain elements (`--emit element`) stay without the runtime warning.
- **`docs/stability.md`: the stage Zubra is in, and a tier for everything it maintains.** Pre-adoption: majors follow new standards as they land, nothing Stable breaks within a major, and the page says what changes once someone else ships on Zubra. Every npm package entry and command is Stable, Supported or Experimental, with the CI job that tests it and what uses it, and so are the crates, server clients, editors, embeds and the registry. A test in the guide-pages job fails when an entry has no row or a row names one that's gone. Writing it found `@zubra/unplugin/rspack` untested (Experimental now) and the Laravel provider never executed in CI.
- **`::slotted()` works in light DOM.** A light-DOM component's `<style>` stops at slotted content, so until now it couldn't lay out what it was given (masonry-grid set `align-self` from script). The compiler now rewrites `::slotted(x)` to the slotted mark, `:where([data-zb-slotted="tag"]):is(x)`, in a second `@scope` with no lower boundary, so the same stylesheet places slotted elements with or without `shadow`, in server HTML before JavaScript and after hydrating. It reaches the slotted elements, not their descendants, adds no specificity, and stays in the component's cascade layer, so page CSS and utilities still win, as across a shadow root. Selector lists are split, and `@media`, `@supports`, `@container` and `@layer` blocks are split inside. Idea from Enhance's style transform. Browser tests: alignment, spans, descendants untouched, page CSS winning, and server-rendered markup.
- **Server templates in Django, Rails and Laravel.** Clients of `zubra serve` for more server languages, each with the same shape as the Python package (a long-lived compiler process behind a lock, a page per request that collects the CSS and modules, a replaced process after a timeout or a crash, so no request gets another's answer), plus their framework's template helpers. **Django** (`zubra.django`): `{% zubra "plot-map" plots=plots %}`, `{% zubra_head %}`, `{% zubra_scripts %}`, a middleware and a module view. **Ruby** (`clients/ruby`, the `zubra` gem): `Zubra.new("components")`, and for Rails `<%= zubra "plot-map", plots: @plots %>`, `zubra_head`, `zubra_scripts`, a Railtie, a Rack middleware and a mountable module endpoint. **PHP** (`clients/php`, `zubra/zubra`): `new Zubra\Zubra(...)`, and for Laravel `@zubra('plot-map', [...])`, `@zubraHead`, `@zubraScripts`, a discovered service provider, a module route and a middleware. In all three the middleware fills in the head and scripts after the response is rendered, so a layout's `<head>` gets the CSS of components its view renders further down. Tests run each against the real compiler; a new CI job runs the Ruby and PHP ones.
- **`npx zubra mcp`: an MCP server that describes a component library to coding agents.** Built from the Custom Elements Manifest, from a components folder, a `custom-elements.json` or an installed library's package name. Its tools: `list_components`; `describe_component` (props with types and defaults, events with their detail types, slots, which props are two-way); `component_usage` (the import and markup for HTML, React, Vue, Svelte, Solid or Angular, in that framework's syntax for props, two-way binding and events); and `check_markup`, which finds props a component doesn't have and events it doesn't fire in markup an agent wrote, with the nearest real name. It speaks MCP over standard input and output, and needs no network, model or account. `@zubra/compiler/mcp` has the pieces. The CLI's help now lists every command.
- **`zubra build --embed`: components for sites with no build step.** One flat folder of ES modules with relative imports (an entry that defines every component, each component, and the production runtime it uses), so a single `<script type="module">` from any static host or CDN is enough, including Shopify's asset folder, which allows no subfolders. Beside it: an HTML snippet per component (Webflow's Embed, Squarespace's code block, any CMS); a WordPress plugin with a block per component (a sidebar field per prop, previewed by the server render) and a shortcode per component (`[star_rating max="10"]`, content into the slots), loading the components as a script module only on pages that use one; and a Shopify theme app extension with an app block per component, its props as settings. All from the components' interfaces; `@zubra/compiler/embed` has `buildEmbed()`. A component that imports an npm package is refused, by name. Tests: the folder's imports, the Liquid blocks rendered with LiquidJS, the plugin run under PHP, and the components loaded in Chromium from one script tag.
- **Testing a library through every framework: `@zubra/runtime/testing`.** `mount(Element, { framework, props, slots })` puts a component in the page as plain HTML, through the React adapter or through the Vue adapter, so one test runs the way each kind of consumer uses it: events reach the framework's own handlers (`events('valuechange')` lists their `detail`s), `set(props)` re-renders through the framework, slots are its children, and a `<prop>change` event updates the prop as a two-way binding would (so React's controlled pattern doesn't put the old value back). `frameworks()` lists the installed ones. It works in any browser test runner; `examples/testing-vitest` runs the registry's star rating through all three in Vitest's browser mode, in CI.
- **Outlets (experimental): a component asks React to render per item.** `<zb-outlet name="row" item={item}>` inside a `zb-each` marks a place the app's framework fills; the React adapter fills outlets from `render<Name>` props (`renderRow={(item) => <Row item={item} />}`) through portals, so the rows keep the app's context, state and handlers, a keyed move keeps each row's state, and a removed row unmounts. A template with an outlet imports `@zubra/runtime/outlet`. Browser tests in React 19 and 18. React only for now, and client-only (the server leaves outlets empty); the protocol (`outletconnect`, `event.claim`) is there for other adapters.
- **Zubra in js-framework-benchmark, and `docs/performance.md`.** An implementation in the benchmark's layout (`benchmarks/js-framework-benchmark/frameworks/keyed/zubra`, one `.zb` file written as the guide teaches), ready to submit upstream, and a runner that checks it with the benchmark's own steps in CI. Timed locally beside vanilla JavaScript and Lit, updates are on a par with Lit; swapping two rows is four times slower, because a keyed `zb-each` moves every row between the two; creating, replacing and clearing rows are 1.3 to 3 times slower.
- **Links inside components go through the app's router.** `routeLinks(navigate)` from `@zubra/runtime/navigation` hands a click on a plain `<a href>` inside a Zubra component to the app's router, so it navigates without reloading the page: React Router (`useRouteLinks(useNavigate())`) and Next.js (`useRouteLinks(useRouter().push)`) from `@zubra/runtime/react`, Vue Router from `@zubra/runtime/vue`, SvelteKit's `goto` and Angular's `navigateByUrl` directly. New-tab and modified clicks, `target`, `download`, `rel="external"`, other origins, same-page `#…` links and clicks already handled are left alone, as are the app's own links; without JavaScript it's a link. Not a router. A router already on the Navigation API (Baseline since January 2026) needs none of it. Browser tests with a hand-written router, React Router and Vue Router.
- **Form libraries: a Zubra control as a field.** `@zubra/runtime/forms` turns what a form library hands you for a field into a control's props: React Hook Form (`registerProps(register('seats'))`, and `fieldProps(field)` in a `<Controller>`), TanStack Form (`fieldProps(field)`), VeeValidate (`vueFieldProps(useField('seats'))`, or a `<Field>` slot's `field`) and Felte (`felteControl`, a Svelte action that keeps Felte's hidden input in step, numbers as numbers). Changes are reported through the control's model pair (`{ prop }` for one that isn't `value`), focus leaving the control is a blur, and the library's `reset()` reaches the control. Nothing imports a library. A browser test runs each library against the same stepper: change, blur, validation, submit and reset. Angular forms keep `zubraModel`.
- **Context from the app: `<zb-context>` and `ZubraContext`.** Components already read context with `inject()`; now the app can provide it. `@zubra/runtime/context` defines `<zb-context>`, a `display: contents` element that answers the Context Protocol for the elements inside it with its `value` (a value or a signal, followed either way) for its `context` key. React and Vue get a `ZubraContext` component (`<ZubraContext context={theme} value={mode}>`); Svelte, Solid, Angular, Lit and plain HTML set the element's two properties. Consumers that asked before it had its key ask again when it announces one, and nested providers answer for their own subtree. Lit's `@consume` is answered too. Browser tests in plain HTML, React 19, React 18 and Vue 3.
- **Signal bridges: state shared by elements and the app's own code.** `@zubra/runtime/bridge` has `subscribe(signal, callback)` and `toStore(signal)`, a store that is at once the Svelte store contract (`$cart`, and writable for `bind:value`), an RxJS-style Subscribable (Angular's `toSignal`, Solid's `from`) and an interop observable (RxJS `from`). React gets `useSignal(signal)` (on `useSyncExternalStore`, so concurrent-safe and server-safe) and Vue gets `useSignal(signal)`, a ref that writes the signal when assigned. Any `Signal.State` or `Signal.Computed` works, or a function of them; `{ deep: true }` also follows mutations inside an array or object. A browser test runs one store through an element and React 19, React 18 and Vue 3 code, each writing and each seeing the others' writes. `docs/what-crosses-the-boundary.md` and the consume skill have the table.
- **A page listing what JavaScript runs where** (`docs/javascript-support.md`, on the docs site under Reference): what the compiler, the browser and the server each do with a component's JavaScript, every built-in the server evaluates, and what it leaves for the browser and why. A test checks the page against the server's V8 comparison both ways, so it can't list a built-in that isn't tested or miss one that is. `zubra check --server`'s help links to it. `Object.values`, `.lastIndexOf`, `.endsWith`, `.trimEnd` and `Boolean()` were evaluated but untested; they now have cases.
- **TypeScript enums.** `enum` in `<script lang="ts">` (and at the top of a `.zb.tsx` file) was refused; it's now lowered in place to what TypeScript writes, with the same number of lines so every line after it keeps its number: an object literal when every member is a constant (`const Size = { Small: 0, "0": "Small", … };`), TypeScript's own statements when a member is computed or the enum is declared twice. Values are worked out as TypeScript works them out (auto-increment, constant arithmetic and bitwise expressions, strings, template strings, earlier members, other enums), and a test runs each kind through both the compiler and `tsc` and compares what they do.
  - **An enum as a prop's type.** `export enum Size { … }` is exported by the element module (`--emit js` and `--emit element`), declared in the typings as `export declare enum`, and re-exported by the React and Vue wrappers, so `import MyBox, { Size } from './my-box.zb?react'` works. A default of `Size.Medium` types the prop as `Size`. A prop typed with an enum the component doesn't export is an error when the enum has a string member (no consumer could pass a value TypeScript accepts) and a warning when it has only numbers.
  - **Enum attributes.** An enum prop's attribute takes a member's value or its name: `size="5"` and `size="Large"` both set `5`; anything else keeps the default, with a warning listing the members. The runtime, `--emit element`, server rendering and `--props` all read the same forms. The manifest records an exported enum as a variable of the module with its values, the prop's type references it, and `--emit html-data` lists the members for the editor's attribute completion.
  - **Enums from other modules.** For an enum imported from a relative TypeScript module (re-exports followed; `./x.js` meaning `./x.ts`), the compiler reads its values. A `const enum`, which TypeScript erases, is inlined: the component gets its own `const Size = { … };` in place of an import that would fail in the browser, and one the compiler can't work out is an error at the import. `@zubra/compiler` sends a TypeScript component's TypeScript modules to the WebAssembly build. Imports from packages aren't followed.
  - `zubra convert` turns an exported enum in an element back into `export enum`, and the enum prop's default back into its member.
- **Effects, scopes and resources work with `using`.** `effect()`'s returned function, `scope()`, `root()` and `resource()` are disposables (`[Symbol.dispose]`), so `using stop = effect(…)` and `DisposableStack` end them where the engine has Explicit Resource Management (Chrome 134+, Firefox 141+, Node 24; not Safari yet). Where it doesn't, they use the symbol TypeScript's downlevel `using` and the polyfills look up, and nothing else changes. `resource()` gains `dispose()`, which aborts the request in flight. Pausing a detached element stays separate from disposal. The typings add `[Symbol.dispose]` only when the project's TypeScript `lib` has it, so older settings still type-check; a tools test checks both. CI also runs the disposal tests on Node 24.
- **Compared with WebUI, FAST, Enhance and WebC** (`docs/compared-with-html-first.md`): the README's copy button written in each, with what each sends to the browser and how fast each server renders a page of ten, measured by `docs/compared/html-first/measure.mjs` and checked in Chromium in a new CI job. It says plainly that rendering without Node.js isn't unique to Zubra (WebUI renders natively; Enhance runs in QuickJS compiled to WebAssembly), and what is: one compiler for server and browser, JavaScript expressions evaluated by Rust (WebUI's templates drop `{{count + 1}}` without a warning, which the test checks), framework wrappers and `--emit element`. It found Zubra's server about 20 times slower than WebUI's on that page, because each component is parsed again on every render.
- **A FAST Element 3 example**, `examples/frameworks/fast-orders`: Zubra elements inside a FASTElement's shadow root, set by `:prop` bindings, heard by `@valuechange`, and reading a currency FAST's `Context` provides through `inject()`. Tested in the framework examples job.

### Fixed

- **Sync: a device never shows an older change over its own newer edit.** Three windows, each found by the long-offline test failing now and then, each now reproduced every time by its own test: a change from elsewhere merged while this device was still storing its edit's clock (it saw no clock, won, and stayed on screen); a change being stored when the device edited the same field (shown after the edit); and a tab closed with writes still queued, which could leave the stored value or its clock behind what the outbox held, so the reopened page showed the old value (and on another device the new one). Edits are now remembered the moment they're made, a change is checked again before it's shown, and on start the outbox is replayed into the store wherever it's newer. The server always had the right value; the device showing the wrong one stayed wrong until that field changed again.
- **Sync: a device offline for hours queues one change per field, not one per keystroke.** The queue of changes waiting to be pushed kept every edit, and rewrote all of them to `localStorage` on each one, so a long session of typing offline grew it without bound until `localStorage` refused it, and from then on a closed tab lost the edits. A newer change now replaces what's waiting for the same field (this device's later write would win anyway); a queue saved before this loads that way too. Proved in a browser: a long offline session, the tab closed before the network came back, another device writing meanwhile, and the app opened again.
- **Actions: processes starting together each find every action.** Each start rewrote the compiled server halves in the shared cache folder, so a second process starting at that moment (another worker, a parallel test file) could import a half-written file, find no actions, and answer every post with 404. They're written beside it and renamed into place now. This was the Fastify adapter test that failed now and then in CI.
- **`class:` and `style:` on a child component set its host element**, as on any element, in both outputs. They were refused as unknown props (`<quantity-stepper class:out={…}>`: "has no prop `class:out`"). Found by Tailgate.
- **Server rendering: an object with an `undefined` field is left for the browser.** The server dropped the key, so `Object.keys({ a: undefined, b: 1 })` read `b` there and `a,b` in V8; JSON can't hold the key, so the expression now renders in the browser.
- **Lists in tables are cheaper to build and clear.** Blank text between table rows and cells (inside `table`, `thead`, `tbody`, `tfoot`, `tr` and `colgroup`, and in the `zb-each`, `zb-if` and `zb-await` bodies there) is no longer kept: a browser never lays it out, and a list's indentation in a `<tbody>` was two more text nodes per row to create, keep and remove. Text inside cells, and whitespace anywhere else, is unchanged. And clearing or replacing every row of a list that is all its parent holds (but blank text) now empties the parent at once instead of deleting a range. In the js-framework-benchmark operations, a 1,000-row table has 3,002 nodes instead of 5,004, and creating rows went from 92 ms to 74.
- **A keyed `zb-each` moves only the rows that are out of order.** It walked the new order and moved every row that wasn't where the walk expected, so swapping two rows of a thousand moved every row between them. It now keeps the longest run of rows already in order and moves the rest, as most keyed renderers do: a swap moves two rows, moving the last row to the front moves one. Both outputs, `@zubra/runtime` and `--emit element`. In the js-framework-benchmark operations, swap rows went from 63 ms to 13.5 ms, level with Lit and hand-written JavaScript. Browser tests count the rows moved and check forty seeded random reorders with rows added and removed.
- **A long-lived compiler renders a component again without parsing it again.** `zubra serve`, the WebAssembly build behind `@zubra/server` and the language server parsed each component (and each component it imports) on every request, and parsed it a second time for its warnings. A parsed component is now kept by its path and text, and reused only while every import it loaded still has the same text, so an edited file or child is parsed again; the warnings are kept by text. Rendering itself still runs per request, since it depends on the props. The README's copy button renders in 17 µs instead of 30 through `zubra serve` (native, JSON included). Found by comparing server rendering with WebUI's.
- **Server rendering: the ES2019–ES2024 array and object methods.** `.findLast`, `.findLastIndex`, `.toSpliced`, `.with`, `.flat` and `.flatMap`, and `Object.fromEntries`, `Object.groupBy` and `Object.hasOwn`, now render on the server instead of leaving an empty region for the browser. An object's keys now come out in JavaScript's order (index-like keys first, ascending), for object literals too, so `Object.keys({ b: 1, 2: 2 })` reads `2,b` on the server as in V8. What the browser would throw on (`.with` out of range, `Object.hasOwn(null, …)`) or that JSON can't hold (`.flat(Infinity)`, an entry with no value) is still left for the browser. Each is in the differential test against V8.
- **`signal(x)` passes the signal for a `let`, a `from()` and a derived `const`**, as the README documents (`watch(signal(count), …)`), instead of compiling to `signal(x.get())`, which passed the value: a context provided with `provide(theme, signal(mode))` now follows `mode`.

- **TypeScript: an import used only as a type no longer reaches the browser.** TypeScript, esbuild and Babel drop an import whose names a module uses only in types, even without `import type`; Zubra kept it, so `import { Option } from './types'` (an interface) made the browser refuse the component's module, and every module importing it, because `./types` has no runtime export named `Option`. Such names are now dropped from the module, and the import with them when nothing else is left, unless the host or the template reads them (`{Size.Large}`). The typings still import them as types. An import the script never mentions is kept, for the template or for its side effects. Both front ends, `.zb` and `.zb.tsx`.

## 5.7.0 — 2026-11-11

Sync grows up for real apps, from what CineStack, the kit and Tailgate found: a page subscribes to only what it shows, and a server can impose that scope for tenancy by key prefix; a log can keep each field's latest value instead of every change; a device whose cursor is past the end of a replaced log starts over; a returning visitor sees what the log has now rather than what their device stored last time; and a field a component doesn't declare is now a tested guarantee. The editor also stops marking every file red when it can't find the compiler.

### Added

- **Sync: a page asks only for what it shows.** `connect({ scope: { seats: 'showing-12/', brands: true } })`: per collection, `true` or a key prefix (or a list of them). Pull, the live stream and presence send nothing outside it, so a page's store holds only its own documents, and each scope keeps its own cursor. `createSyncServer({ scope({ request }) })` imposes one from the server, which a page's can only narrow, and refuses pushes and presence outside it: tenancy by key prefix on one log. The `zubra-sync` binary honours a page's scope. Found by CineStack, where every guest's phone received every seat in every showing.
- **Sync: a log that keeps each field's latest value.** `sqliteLog(path, { keep: 'latest' })`, and the same option on `memoryLog` and `durableObjectLog`: a newer clock replaces a field's row and takes the next cursor, an older one is dropped, so the log doesn't grow with every change and a new device reads what's there now. Opening an existing full log this way carries each field's latest value across, after the old cursors. The SQL logs now share one implementation. Found by CineStack, where seats are held and released all evening.
- **Sync: a field a component doesn't declare is a guarantee now**, documented and tested on both servers: a server-written field with no `let` (the kit's hold `since`) is kept on the device and in the log through the component's own edits.

### Fixed

- **Sync: a returning visitor sees what the log has now, not what their device stored last time.** On a connected page, a component waits for the first pull (at most 1.5 seconds, and not at all once it fails, as it does offline) before applying its stored document. Before, a stored value showed until the pull landed: a seat that had been taken since the last visit showed free. Found by CineStack.
- **Sync: a device whose cursor is past the end of the log starts over.** When the log was replaced or wiped, a device that had read far into the old one heard nothing until the new log passed its cursor. Pull and the live stream now answer it from the start, with `reset: true`, and the device takes the new cursor. Logs gain `head()` (the built-in ones and the `zubra-sync` binary have it; it's optional for your own).
- **The editor no longer marks every `.zb` file red when it can't find the compiler.** "couldn't run the compiler `zubra` (ENOENT)" was an error at line 1 of each open file, though nothing was wrong with them. Now it's one warning, and the language server looks in more places first: a cargo build in a zubra checkout (`target/debug` or `target/release`, as `@zubra/server` already did), the `@zubra/compiler` nearest the file rather than only the workspace's (an example app with its own `node_modules`), and on Windows the `zubra.cmd` npm installs, which spawning without a shell never ran. A compiler built or installed afterwards is picked up without reloading the window.

## 5.6.0 — 2026-11-11

Sync and Actions on Cloudflare Workers, and five fixes found by building a real app on Zubra (Tailgate, a farm-to-door marketplace): the Sync server can read and write documents itself; a Durable Object holds it on Workers (`@zubra/sync/durable`), with the log in the object's own SQLite; server functions are built ahead of time for the edge (`zubra-actions build`, `@zubra/actions/edge`); and the standup board runs on a Worker in CI. On the server, an unsafe URL from a value is now left out and reported instead of failing the render, rendered components go inside slots, nested form controls submit before JavaScript, and `hydrated()` is `false`.

### Added

- **The standup board on a Cloudflare Worker** (`examples/edge/standup-worker`), the proof for Sync and Actions on Workers: its Sync server is a Durable Object, its "Lead today" form posts to a server function that races through the object, and its pages come from `@zubra/server/edge`. A CI job runs it in workerd with two browsers (the page before JavaScript, typing and presence, two people racing for the lead, the form without JavaScript, the log surviving a restart) and runs Sync's log contract inside a Durable Object. `docs/edge.md` has the section.
- **Actions on Cloudflare Workers: `@zubra/actions/edge` and `zubra-actions build`.** A Worker can't compile a components folder when it starts, so `zubra-actions build components --out src/actions` writes the server functions as plain modules for the bundler, and `createActions({ actions })` from `@zubra/actions/edge` answers posts exactly as the Node entry does: both now run the same request handling (`core.js`), and a test sends each the same posts (plain and enhanced, errors, redirects, cross-site, unknown) and compares status, headers and body. `context` gets fetch's second argument, so a Worker's `env` reaches server functions. `docs/actions.md` has the page.
- **Sync on Cloudflare Workers: `SyncObject` and `syncStub`** in `@zubra/sync/durable`. Extend `SyncObject` for a Durable Object that holds the sync server (one per app, its log in the object's SQLite) and asks your `authorize`; the Worker's `syncStub(env.BINDING)` forwards `/_zb/sync/*` to it, reads a copy of the documents for rendering, and writes as the server. What must not interleave (the last item, a job two drivers claim) goes in the object's own methods, which the stub calls over RPC. A page whose connection is cut leaves its presence rooms within about three keep-alives (2 s each here): a Durable Object only learns it's gone when it can't write to it. `documents()` gains `collections()`. `docs/sync.md` has the page.
- **A sync log in a Cloudflare Durable Object: `durableObjectLog(ctx.storage)`** from the new `@zubra/sync/durable`. The same table and cursors as `sqliteLog`, over the object's own SQLite, one transaction per batch; `table` names it if the object keeps tables of its own. Every log Sync ships now passes one contract (order, cursors and paging, JSON values, a failed batch adding nothing), and the edge example runs it on workerd's storage. The first part of Sync and Actions on Workers (`plan/roadmap-durable-objects.md`).
- **The Sync server can take part: `sync.documents()` and `sync.write()`.** `documents()` is every document as the devices merge it, kept current, with synchronous reads; `write(collection, key, fields)` writes as the server, with a clock later than any it has seen, to the log and every live page. A server action can now check and decide what two people both want (the last item, a job two drivers claim) and every page showing it follows. Tailgate wrote these 40 lines itself; they're in `@zubra/sync/server` now.
- **`authorize` is told what kind of request it is**: `kind` is `'change'`, `'presence'` or `'read'`. A rule that kept a collection the server's alone used to refuse joining its documents' presence rooms too, since both are writes; now it can tell them apart. `write` is unchanged.

### Fixed

- **`zubra check --server` points at the right place for a gap inside a child component.** It reported the child's line and column as if they were the parent file's, often landing on a CSS rule. Now the warning is at the child's tag in the parent and says where in the child it is: `inside <user-avatar> (user-avatar.zb:26:60): …`. Found by Tailgate.
- **`hydrated()` called in a template is `false` on the server**, as `const live = hydrated()` already was. `<zb-if test={!hydrated()}>` rendered nothing on the server, so the no-JavaScript fallback it guarded was missing exactly when it was needed; `!hydrated() || …` and `hydrated() && …` are decided by it too. Found by Tailgate.
- **A form control inside another component submits before JavaScript.** A form-associated child with a `name` (a quantity stepper in an order form) now carries a hidden input with its rendered value, as one under a framework's SSR bridge already did, so a form posted without JavaScript sends it. The element removes it when it starts. Before, the server rendered nothing for the form to send. Found by Tailgate, whose order form submitted no quantity without JavaScript.
- **A rendered component can go inside another's slot on the server.** `page.render('frame', props, { default: page.render('chart', …) })` failed with "doctype and processing instructions are not supported": slot HTML is kept as written, but since 5.0 the hydration markers are processing instructions (`<?zb [?>`), and only comments were kept. Processing instructions are kept now, so both components render on the server and hydrate. Found by Tailgate's dashboards (charts inside `dashboard-shell`).
- **An unsafe URL from a value no longer fails the server render.** A computed `href`, `src` or `srcset` that isn't safe (a user's `javascript:` link, a `data:` image) is left out of the HTML, as the element leaves it out in the browser, and both say so: the browser in the console, `@zubra/server` through a new `warn` option (`console.warn` by default), naming the attribute and the start of the value. Before, `@zubra/server` threw, so one bad value took the whole page down. Unsafe literal URLs are still compile errors. Found by Tailgate, where a farmer's uploaded logo returned a 500 for the market page.

## 5.5.0 — 2026-11-10

Motion, and six lines of work reviewed and released together: content that leaves instead of vanishing; Zubra on Cloudflare Workers; a Rust crate and a Python package for servers that aren't Node; spread onto components; Extract to component and Format Selection in the editor; a Prettier plugin; and pages for Angular, Vue, Svelte and React developers.

### Added

- **Motion: `animate` on `<zb-if>`, `<zb-switch>` and a keyed `<zb-each>`, and `zb-animate` beside an element's `zb-if`.** Content going away stays with `data-leaving` and `inert` until the transitions and animations that starts have ended (infinite ones aren't waited for), beside what replaces it; keyed rows that stay glide to their new places (FLIP, with the Web Animations API, timed by `--zb-move-duration` and `--zb-move-easing`), and removed rows leave held where they were on screen, out of the flow (even in a list anchored to the bottom, which shrinks from the top). Coming in is left to CSS (`@starting-style`). Under `prefers-reduced-motion: reduce`, nothing waits or glides. Both outputs have it: `@zubra/runtime` and `--emit element` (its `leave` and `glide` helpers, written only when a component animates), and `zubra convert` reads them back as `animate`. The same functions are `leave()` and `glide()` in the new `@zubra/runtime/motion`, which a compiled module imports only when its component animates (the runtime's own hooks are about 160 B, and its size budgets rise by 0.5 KB for them). `animate` without a `key`, with a value, or `zb-animate` anywhere but beside `zb-if` are errors that say what to write. Tested in the browser on both outputs, including reduced motion.
- **Zubra for Angular developers** (`docs/guide/for-angular-developers.md`, in the docs site's navigation): a translation table (signals, `@if`/`@for`, `output()`, `model()`, `ng-content`), how to use a component from an Angular app with `ZubraModel` and `formControlName` (its code is quoted from the `angular-booking` example, and the `guide-pages` check fails if they drift), each claim linking the test that checks it, and what doesn't cross, including that templates aren't type-checked and Angular's own SSR is untested.
- **The Vue, Svelte and React guide pages** now have the same four parts as the Angular one: the translation table, how to use a component from your app (quoted from `vue-budget`, `svelte-flashcards` and `react-board` through marked regions, checked by `guide-pages`), each claim linking the test that checks it, and what doesn't cross for that framework, ending with the survey question.
- **A check that the "Zubra for … developers" pages match the code that runs in CI** (`docs/test/`, a `guide-pages` job). A code block that says where it comes from (`<!-- snippet: examples/frameworks/vue-budget/src/App.vue#name -->`) must equal the `zubra-snippet:start name` … `end name` region of that file; links must resolve; and every framework page has the same sections (translation table, using a component from the app, what you get with each claim linking its test or example, what doesn't cross, and the survey question). No page uses it yet: the Angular page and the revised React, Vue and Svelte pages follow.
- **The repository is formatted with `zubra fmt`, and CI checks it** (`zubra fmt --check .` in the Compiler job). The reformat is one commit, listed in `.git-blame-ignore-revs` so `git blame` skips it (`git config blame.ignoreRevsFile .git-blame-ignore-revs`). Every component compiles the same before and after.
- **Range formatting.** Format Selection in editors (and format on paste) formats the lines the selection touches, and nothing else: the edit is cut from the whole file's formatting, so the depth and line widths are the file's, not a fragment's. In the request API, `command: "formatRange"` with `start` and `end` (bytes) answers `{ "edit": null | { start, end, text } }`; in Rust, `format_range`. The language server advertises `documentRangeFormattingProvider`; a compiler without the command is told to update. Tested over every component in the repository: the text outside the edit is unchanged, what the component compiles to is unchanged, applying the edit twice changes nothing, and the range of the whole file is the whole format.
- **`<!-- zubra-fmt-ignore -->`** as a file's first line leaves it exactly as written, in `zubra fmt` (and `--check`), Format Document, Format Selection and the Prettier plugin. It's read before the file is parsed, so a fixture that is malformed on purpose can carry it.
- **`prettier-plugin-zubra`**: Prettier for `.zb` files. The template is laid out by `zubra fmt` (the plugin calls `format()` from `@zubra/compiler`, at `zubra fmt`'s line width of 100 by default instead of Prettier's 80, so a file Prettier has formatted passes `zubra fmt --check`), and the `<script>` and `<style>` bodies by Prettier with your configuration: JavaScript, TypeScript (`lang="ts"`), CSS, SCSS and Less, indented one level inside their tag, template literals untouched. A body that doesn't parse or has no parser is left as written; `embeddedLanguageFormatting: "off"` leaves all of them. Its tests format every component in the repository and check it compiles to the same JavaScript and CSS (ignoring only what Prettier chooses: whitespace, quotes, semicolons, trailing commas). Not published yet.
- **`{...object}` onto a Zubra component.** `<ui-button {...rest}>` no longer needs every prop written out. The entries that are the child's props (`isOpen` or `is-open`) are passed as props and checked like written ones, the rest become attributes and listeners of its host, as on any element. A prop written on the tag wins over the spread's, in either order; `null`, or a key that goes away, puts the prop back to the component's default, on the server and in the browser alike; of two spreads the later one's value wins; and a spread may give a required prop (one known only in the browser isn't asked for it at build time, one known at build time must have it). A spread known at build time renders on the server; one known only in the browser leaves the child to render its defaults until it runs. Also in JSX components, and `zubra convert` no longer reports "spreading onto a component isn't converted"; the rest of the props spread onto a returned component (`<Button {...props}>`) are reported, not dropped, since they would be that component's props. Still an error on the host tag and on directives.
- **The bike shop on a Cloudflare Worker** (`examples/edge/hono-bikes-worker`). The Hono + htmx shop's routes moved into `src/shop.js`, which reads no files, so the Node.js app and a Worker share them and the same four components. A test runs the Worker in workerd (`wrangler dev --local`) and compares status, redirects and HTML to the Node.js app's for lists, searches, pages, fragments, selling and edit errors, byte for byte. `docs/edge.md` has the setup and the measured bundle size.
- **`@zubra/server/edge`: the server on Cloudflare Workers.** `createZubra({ wasm, components: { 'price-tag': source } })` takes the compiler's WebAssembly module and the components' sources instead of a components folder, and returns what the Node entry does (`render`, `page()`, `head()`, `scripts()`, `module()`, `describe()`, `injectShadowRoots()`, `fetch()` for the browser modules), with the same output: a test compares the two entry points on the same components, nested relative imports included, down to the streamed page. `page().streamResponse()` streams as a web `Response`; `stream()` (a Node Readable) stays on the Node entry. The runtime isn't served from here (a Worker has no disk to serve it from): put `@zubra/runtime` in your static assets under `<prefix>/runtime/`, or point the import map at a CDN with `imports`. `@zubra/server/hono-edge` is the Hono middleware over it. Components in a Worker are text imports (a `Text` rule for `**/*.zb` in `wrangler.jsonc`).
- **`@zubra/compiler/wasm`: the compiler without a host.** `createCompiler(wasm)` returns `{ request, render, renderToString, format }` over the WebAssembly module you give it (a `WebAssembly.Module`, an instance, or its exports), and reads nothing: no file system, no process, no `import.meta`. That is what Cloudflare Workers, Deno and browsers need, since `@zubra/compiler` itself loads `zubra.wasm` from disk at import time, which a Worker can't do (the edge probe in `examples/edge/probe` shows the failure and the fix). In a Worker, `import wasm from '@zubra/compiler/zubra.wasm'` gives the compiled module (the package now exports that path). `render` takes the sources as `files`, since there is no disk to read them from. The Node entry is this one plus the disk loader, so there is one implementation of the request glue, `render` and `format`; its behaviour is unchanged, and a test renders every registry component through both and compares the results. Also exports `CompileError` and the marker constants, the same ones.
- **The `zubra` Python package** (`clients/python`, version 0.1.0, versioned on its own): the Flask example's `zubra.py` as a package. `Zubra(folder)` keeps one `zubra serve` process (restarting it if it dies, with a lock for threads) and gives `Page.render`, `Page.head()` and `Page.scripts()`, `css()` and `js()`; `zubra.jinja.install()` adds `zubra()`, `zubra_head()` and `zubra_scripts()` to a Jinja environment. It finds the compiler from `compiler=`, `$ZUBRA_COMPILER`, a binary bundled in the wheel, then the PATH. `scripts/build_wheel.py` assembles a platform wheel (`manylinux_2_35`, `musllinux_1_2`, `macosx`, `win_amd64`) from a release archive, standard library only. The Flask garden now uses the package and its `garden/zubra.py` is gone; its tests are unchanged. Not on PyPI yet.
- **A Rust server example, `examples/backends/axum-garden`**: the Flask garden's pages and `.zb` files from an Axum binary, with `include_zb!` checking the components at build and `Component::render` writing the HTML in the server's own process (no Node.js, no child process). Its test fetches every page from both servers and requires the same HTML (and byte-identical browser modules); CI runs it beside the Flask suite.
- **`zubra-macros`: `include_zb!("components/price-tag.zb")`**, for Rust servers. A procedural macro that compiles the component (and every component it imports) during `cargo build`, so a broken `.zb` fails the build with Zubra's message, file and line, and expands to a `zubra::Component` with the sources embedded (`include_str!`, so editing any of them rebuilds the crate; paths are relative to the crate, not the build machine). Not published yet (`publish = false`).
- **`zubra::Component`, the Rust API for servers**: a component and the sources it imports, held in memory, with `render(&props)` (partial server HTML, like `@zubra/server`), `render_with` (slots), `css()`, `module()` / `module_for(runtime)`, `tag()` and `check()`. It resolves relative `import`s from the map, so a Rust server needs no disk, no Node and no child process. The crate documentation now lists the supported surface (`Component`, `Diagnostic`, `compile_html_with_options`, `compile_js_options`, `compile_css`, `format`, `handle_request`); the older entry points that take JSON strings are hidden from the docs, not removed.
- **Prebuilt `zubra` binaries on every release**: Linux (glibc and static musl, x64 and arm64), macOS (Intel and Apple silicon) and Windows, each with the licence and readme, and a `SHA256SUMS` file uploaded last. Built from the release's tag by `release.yml`, started once the release exists and skipped when the release already has its checksums (so a failed build can be re-run). It's how a Flask, Rails or Laravel app gets `zubra serve` without Node or a Rust toolchain. `scripts/package-binary.sh` builds an archive; its test runs in the Compiler job. The first release to carry them is the next one.
- **Extract to component in editors.** Select whole sibling nodes of a template and the language server offers the code action *Extract to component* (any LSP editor): a new `.zb` file beside the current one, `<new-tag …>` in place of the selection, and the import. When the compiler refuses the selection, the action shows disabled with the reason. It's offered only to an editor that said it can apply an edit creating a file (and a disabled action only to one that knows them), and a name whose file already exists is refused before any edit. The VS Code extension adds *Zubra: Extract to Component…*, in the palette and the context menu, which asks for the name (the code action uses a default). A compiler from before the command is told to update, not trusted.
- **`command: "refactor"`, `action: "extract"` in the request API: markup to a new component.** Give it a file, the byte range of whole sibling nodes in its template and a tag, and it answers with the new component's file and the edits to the current one (the selection becomes `<new-tag prop={prop} onevent={handler}>`, and the import is added). What the selection reads from outside becomes a required prop; a function of the component used as a whole handler (`onclick={remove}`) becomes an event the new component fires with `emit` and the parent listens to; names the component imports are imported again. It refuses, with the reason, a selection that assigns to the component's state (`count++`, `value:bind={count}`), contains a `<zb-slot>`, uses a function other than as a whole handler, fires the component's own events, splits a `zb-if`/`zb-else` or `zb-await` chain, holds markup that only works inside its parent (`<option>`, `<tr>`), or sits in a shadow DOM component. The selection is checked against the file itself: one that starts or ends inside a tag, a comment, a `{…}` expression, a word or a `<textarea>` is refused (parsed on their own, an attribute's value or a string in an expression can look like markup). Also refused: content placed in a slot (`slot="title"`), a handler function that takes the event as its argument (as a listener on the new component it would get that component's event), a function or browser-only value that would have to be a prop the server can't pass, and a tag that is Zubra's own or already used. A `zb-each` item's name is the loop's only inside the loop; an import brings in the names it binds, not any word in it; and what the browser provides (`setTimeout`, `fetch`, `localStorage`) isn't a prop. What would be written is compiled before it's offered: a component that compiled still compiles, and one that rendered on the server still renders. `<pre>` and `<textarea>` content is moved exactly as written. What it writes is laid out as `zubra fmt` would lay it out (the new file, and the lines of the edited one that the new tag is on) and in the file's own line endings, so a repository that runs `zubra fmt --check` doesn't fail on a refactoring its editor offered. No CSS moves: descendant rules still apply, but a rule or layout that depends on the selection being a direct child sees the new element instead. In the tests, every subtree of every component in the repository is extracted, and so are thousands of arbitrary selections (inside tags, comments, expressions): each is refused, or both files compile and the page is the same apart from the new tag. The language server offers it as a code action and VS Code has a command (below).

### Changed

- **`zubra fmt` keeps a file's line endings.** A file with CRLF line endings stays CRLF (the first line break decides); it used to be rewritten with LF, so on a Windows checkout `zubra fmt --check` called every file unformatted. Format Selection's edits use the file's line endings too, instead of putting bare LF into a CRLF file.
- **`@zubra/server` is built on a shared `core.js`.** Everything that doesn't need a disk (rendering, CSS, browser modules, a page's head and scripts, streaming, shadow roots) moved out of `index.js` into a file that imports nothing from Node; `index.js` adds the folder walk, the runtime from disk, `writeAssets` and the Node streams. Behaviour is unchanged and the existing server tests pass untouched; `streamResponse()` now builds its web stream directly rather than converting a Node Readable.

### Fixed

- **The docs no longer say Svelte's `bind:` works on a Zubra element.** Svelte 5 refuses `bind:value` on a custom element at compile time; the Svelte page, `docs/what-crosses-the-boundary.md`, the framework matrix and the README now show the prop with its `on<name>change` event, which is what the flashcards example does.
- **The Angular example and `npm create zubra`'s Angular template type-check their `.zb` imports** (`"types": ["@zubra/unplugin/client"]`): TypeScript 6 reports an unresolved side-effect import.
- **Format Selection no longer fails on a position inside a multi-byte character.** `formatRange` (and `zubra::format_range`) sliced the file at the offset it was given and panicked when that fell inside a character such as `é` or an emoji; the editor then said the compiler was too old. An offset inside a character now counts as the character's start.
- **A streamed page works from a bundled server.** The two scripts `page.stream()` and `streamResponse()` put in the page were the server's own functions, stringified; a bundler rewrites those for the server it builds (esbuild's keep-names, which Wrangler turns on, wraps an inner function in a `__name()` helper that exists only in the bundle), and the page threw in the browser. They are now kept as text. A test bundles `@zubra/server/edge` the way Wrangler does and compares the page.
- **Markup nested more than 256 elements deep is a compile error**, in a template and in slot content, instead of a stack overflow: natively a crash, and in the WebAssembly build a trap that left the compiler failing every request after it, for as long as the process or the Worker's isolate lived. Slot content is the page's HTML, so this could be reached from a request.
- **`@zubra/compiler` starts a fresh WebAssembly instance after a trap.** The request that trapped throws a `CompilerCrash` (new, exported from `@zubra/compiler` and `@zubra/compiler/wasm`); the next request is answered. `createCompiler()` can do this when it's given a `WebAssembly.Module`; given an instance, it throws `CompilerCrash` from then on instead of raw traps.
- **`zubra::Component` (and the request API) resolve imports for a component whose path has no directory.** `Component::new("card.zb", …)`, which is what `include_zb!("card.zb")` writes for a component beside `Cargo.toml`, looked for `./badge.zb` at `/badge.zb`: the build passed and every render failed with "not among the component's imports". A request whose `path` was a bare file name failed the same way.
- **The Python package can't hand one request another's HTML.** A request that was interrupted after it was sent (a thread interrupted, or now a timeout) left its answer in the pipe for the next caller. Whatever ends a request early now ends the compiler process too, under the lock, and the next request starts a fresh one. New: `Zubra(…, timeout=30.0)`; a compiler that isn't there, can't run, exits, or answers with something that isn't JSON is a `ZubraError` that says what to do.
- **Linux wheels of the Python package are built from the static (musl) binaries** and tagged `manylinux_2_17` and `musllinux_1_1`, so they install on RHEL 9, Amazon Linux 2023 and Debian 11. They were tagged `manylinux_2_35`, the glibc of the machine that builds the glibc binaries.
- **`include_zb!` reports one error**, not two, when the component doesn't compile (the second was about a stray `;`), and takes a literal passed on by another macro (`macro_rules! page { ($path:literal) => { include_zb!($path) } }`).
- **The release workflow**: the jobs that build the binaries hold no publishing or release-writing token (each job now asks for its own permissions); a release tagged before binaries existed is skipped instead of failing the job on every push; and the Windows archive is uploaded by a path the upload step can open.
- **`scripts/bump-version.sh` updates the Axum example's own lockfile** and the version `zubra-macros` asks of `zubra` (now exactly the release's). The example's `cargo test --locked` failed after any version bump.

## 5.4.1 — 2026-11-09

The VS Code extension's language server starts, so `.zb` files have a formatter (and diagnostics, completion and hover) in VS Code. And the Zubra DevTools in the demo gallery, on the playground, and in builds when you ask for it.

### Added

- **The Zubra DevTools in builds, when you ask for it.** `zubra({ devtools: true })` in `@zubra/unplugin`, `devtools` in `createZubra()` (on by default outside production) and in `buildLibrary()`, or `ZUBRA_DEVTOOLS=1` for all three. Components are compiled for the extension and `@zubra/runtime` resolves to its development build, which has the hook. Production builds still leave it out unless asked. The demo gallery builds with it, so the extension works in every live demo, and the gallery test checks that it does.
- **Zubra DevTools on the playground.** The previews are compiled for the DevTools extension, so you can try it without a project: open the playground, select an element in a preview, and the Zubra pane shows it; clicking a line selects it in the playground's editor. The page's own `__ZUBRA_DEVTOOLS__` passes the pane's calls to the preview frames, and the pane now reads the hook of the frame the selected node is in. The runtime's `open()` lets a page handle a location itself (a cancelable `zubra:open` event) before asking Vite.

### Fixed

- **The VS Code extension's language server starts.** The extension looked the server up as `@zubra/language-server/package.json`, which that package's `exports` map doesn't allow, so activating threw before the server began: `.zb` files had no formatter ("There is no formatter for 'zubra' files installed"), and no diagnostics, completion, hover or go to definition either. It now resolves the package's own entry, and starts it as a Node module, which VS Code forks with `ELECTRON_RUN_AS_NODE=1` (as a command, `process.execPath` is the editor's Electron binary). A test activates the extension and starts the server the way the client does.

## 5.4.0 — 2026-11-09

The output you learn from: `--emit element` writes the custom element you'd write by hand, `zubra convert` takes one back to `.zb`, and the playground shows it. And Zubra DevTools, a pane in the browser's Elements panel.

### Added

- **`zubra fmt`**: lays `.zb` files out consistently (indentation by nesting, tidy tags, one attribute per line for a tag too wide for its line) without changing what they compile to: it only touches whitespace that renders as one space, and leaves expressions, comments, attribute values, `<script>`/`<style>` bodies and `<pre>`/`<textarea>` as written. Files and folders, `--check` for CI, `--stdin` for editors, `--indent`, `--tabs`, `--width`. Also `format()` in `@zubra/compiler`, `command: "format"` in the request API, and `zubra fmt` in the npm CLI. Every component in the repository is formatted in the test suite and compiles the same.
- **Formatting in editors.** The language server answers Format Document with `zubra fmt`'s layout and the editor's indentation (tab size, tabs or spaces), so it works in any LSP editor. The VS Code extension makes it the default formatter for `.zb` (format on save with `editor.formatOnSave`), and adds `zubra.format.printWidth`. With a compiler from before this release it says once that formatting needs 5.4 and changes nothing.
- **An Element tab in the playground**, next to Preview: the component as `--emit element` writes it, or why it's refused. The JavaScript tab is now called Runtime module, which is what it shows and what the preview runs.
- **`npm run pack` in `editors/devtools`** makes the store zip with Node alone (no `zip` program, which Windows lacks): `manifest.json` at its root, the same bytes for the same files.
- **`--devtools`** (and `devtools: true` in requests), for development builds: each part of the compiled module records where it was written in the `.zb` file (`at: [line, column]`), the definition records the file and its host tag's place (`source`), and `setup` hands the runtime the script's signals by name. It's what the browser DevTools panel reads; without the flag the output is unchanged, byte for byte.
- **`globalThis.__ZUBRA_DEVTOOLS__`**, in the runtime's development build: what the browser DevTools panel reads. `inspect(node)` gives the node's component (its `.zb` file and line), its props and state by name with their values, its bindings as the DOM operations they perform (`textContent = …`, `classList.toggle('done', …)`, `addEventListener('click', …)`) with each one's source line and the named signals it depends on (looked up through `Signal.subtle.introspectSources`, so `items[0].done` rather than an internal signal), what a parent binds onto a child component, and the last update: what was written and which bindings re-ran. Recording is small and always on in development (the size budget for `src/index.js` went from 14 KB to 14.5 KB, gzip); the reading side loads when the extension calls `connect()`. The production build has none of it: `dist/production` is byte for byte what it was.
- **`@zubra/unplugin` compiles for the DevTools in Vite's dev server** (`--devtools`), where it already sets up hot reloading. Builds are compiled as before.
- **Zubra DevTools** (`editors/devtools`), a browser extension for Chrome, Edge and Firefox: a Zubra pane in the Elements panel showing the selected node's component (with Open in editor at its `.zb` line, through Vite's `/__open-in-editor`), its props and state, its bindings with the signals they read, what a parent binds onto it, and the last update. Manifest V3, no permissions or content script: it reads the page with `inspectedWindow.eval`. Load it unpacked for now (its README says how); `scripts/bump-version.sh` keeps its version the project's.
- **`zubra convert my-element.js`: a custom element back to a `.zb` component.** It reads the shape `--emit element` writes (one you compiled and changed, or one written by hand that way) and undoes the emitter: props from `static zubra` or `observedAttributes` and `#props`, the script as written (`element.count` is `count`, `state(0)` is `let`, hooks imported again), each `bind()` back on its node as an attribute, `class:`, `style:` or text, listeners as `on…` with their modifiers read back, `list()`/`when()`/slots as `<zb-each>`/`<zb-if>`/`<zb-slot>`, and the stylesheet unscoped. Every component `--emit element` accepts (61 in the registry and the runtime's tests) converts back to a `.zb` file that compiles to the same element, and a test checks that. What it can't place is reported with `not converted:` at its line.
- **`service-status`, a registry component** (`npx zubra add service-status`): a service's status from a JSON endpoint, with "Checking…", the status and its message, the error with Retry, and Refresh that keeps the last answer showing. It's the registry's first `zb-await`, so the stripped-markers suite now covers a region the server leaves to the element. That suite now compares against the same markup with its markers kept (the same server nodes must survive), since a pending `zb-await` is re-rendered either way, and it fails if a component warns even with its markers.
- **Server markup with an `zb-await` hydrates in place without its markers.** When a sanitizer has removed the `<?zb …?>` markers, `remark.js` now places an `zb-await` region by structure, as it does `zb-if` and `zb-each`: its `zb-then` block, for a value the server knew at build time, or its pending block, which the element renders afresh anyway. Until now such an element rendered entirely afresh, losing text typed and focus taken before JavaScript.

### Changed

- **A JSX component's `--emit element` output reads like a `.zb` component's.** Its script was lowered for the runtime first (`$p.text`, `__zubraAssign(…)`) and bridged with a `$p` object; it's now lowered the way `zubra convert --as zubra` writes it, so the element has `element.text`, `count.value += 1` and `emit("change", …)`. Its text still follows JSX's whitespace rule, and a JSX child component is resolved to its tag.
- **`--emit element` writes the custom element you'd write by hand.** Until now it was the `--emit js` module with a small runtime (`$define`, about 750 lines) inlined, which worked but was hard to read. It's now one class that extends `HTMLElement`: `observedAttributes` and an `attributeChangedCallback` that parses each prop's type, a getter and setter per prop, `connectedCallback`, your `<script>` as written (props as `element.name`, state as `name.value`), the template's changing nodes looked up by position and named after their class, id or tag, and one `bind(read, write)` line per dynamic spot with the DOM call it makes. Keyed lists, conditionals, light-DOM slots and deep state are small commented helpers after the class, each written only when the component uses it. The output is smaller too: about 2 KB gzipped for a small element (was 5.5 KB) and 3.5 KB with slots (was 7 KB). What it covers and refuses is unchanged, and the runtime's browser suites and the registry's tests pass on it as before.
- **A slot inside `zb-then` or `zb-catch` is reported as such.** The error said "can't be inside zb-each" wherever the slot was; it now names the branch it's in and says to put the slot outside the `zb-await`.

### Fixed

- **DevTools: the last update names writes to elements that were on the page before the pane connected.** It said "no named writes" for them until they had been inspected once.
- **DevTools: a form control's live state is named as the property the runtime sets** (`.value = …`, `.checked = …`), not as `setAttribute` or `toggleAttribute`.

## 5.3.0 — 2026-11-09

Zubra Actions and Zubra Sync: a component's form can post to a server function, with or without JavaScript, and a component's state can live on the device, shared across tabs and devices.

### Added

- **`export async function save(formData) { 'use server'; … }`** in a component script. The function, and the imports only it uses, never reach the browser: its name becomes the URL of its endpoint (`/_zb/action/<tag>/<name>`), and `<form action={save}>` (or `<button formaction={save}>`) gets that URL as a literal `action` with `method="post"`, in the server HTML and the template alike. Any other `export` is still an error.
- **`--emit server`** (and `emit: "server"` in requests): the server half of a component, its server functions with the imports they need, and `actions`, a map from URL to function.
- **`@zubra/actions`**, a new package that serves them. A post with `Accept: application/json` gets the return value as JSON; the browser's own post gets `303 See Other` back to the page, with the result in a one-use cookie that `actions.result(request)` reads. Cross-site posts are refused, a thrown error is a generic 500, and a returned `Response` passes through. `actions.script()` adds a small module that sends those forms with `fetch` instead, sets `aria-busy` while they're in flight, and fires `beforeaction` (cancelable) and `action` on the form. A fetch-style core (`fetch(request)`), Node's `handle(req, res)`, and Hono, Express and Fastify adapters.
- **`'use collection <name>'`** at the top of a component script. Its top-level `let`s become the fields of a document keyed by the `doc` prop (or the props after `by`: `'use collection rows by list, item'`), and the compiled module calls `@zubra/sync` with them. A key prop the host doesn't declare is a compile error.
- **`ephemeral(value)`** from `@zubra/sync`: state that isn't stored. The server renders its value.
- **`@zubra/sync`**, a new package: keeps those documents in IndexedDB (in memory without it). Writes are signal assignments, saved behind the UI; an element saves nothing until its document has loaded; elements and tabs showing the same document follow each other (BroadcastChannel). Last-writer-wins per field. `configure({ store })` takes another store.
- **`@zubra/sync/connect`** and **`@zubra/sync/server`**: share documents between devices through a log over plain HTTP (`POST …/push`, `GET …/pull?since=`). Each changed field is stamped with a hybrid logical clock and queued until the network allows; every device applies last-writer-wins per field to the same changes, so they converge. The server keeps the log in order (in memory by default, or any `{ append, after }`), with `authorize()` for writes and reads.
- **A live channel**: `GET /_zb/sync/live` streams changes as they're pushed (server-sent events); `connect()` uses it and polls only while it's down. `createSyncServer().handle(req, res)` serves it on Node.
- **Presence**: `let cursor = presence(v)` is shared live with the document's other viewers and never stored; `let others = peers()` is the array of them, `{ peer, ...presence }`. Across tabs with no server (BroadcastChannel), and across devices through `connect()` (`POST /_zb/sync/presence` and the live stream). At most one message a frame, a heartbeat, a 30-second timeout, and a goodbye on `pagehide` or a dropped connection. The server renders `presence()` values and an empty `peers()`.
- **`sqliteLog(path)`** from `@zubra/sync/sqlite`: the log in a SQLite file, through `node:sqlite` or `bun:sqlite`. The live stream now sends a backlog longer than one page whole before anything live.
- **A write could be lost on a slow network.** Two pushes can be out at once (the debounce and the poll loop). When they came back, each removed as many changes from the outbox as it had sent, counting from the front, so a change made while they were out could be removed without ever being sent. A push now removes exactly the changes it sent. Found by a CI run where the checkbox change never reached the log.
- **`connect({ webrtc: true })`**: presence over WebRTC data channels between viewers of a room, once they've met; the server carries introductions, goodbyes and signaling (`POST /_zb/sync/signal`, a `signal` event on the target's live stream), and presence to anyone without a channel. ICE servers are configurable; TURN is the app's. Both servers support signaling.
- **`zubra-sync`**, a binary (`sync-server/`, `cargo build -p zubra-sync`): the sync protocol, live stream and presence included, with SQLite built in and no Node.js. Same table as `sqliteLog()`; CORS for `--origin`s. The protocol and browser tests run against it too.
- **`@zubra/server` serves `@zubra/sync` by itself** when it's installed, and maps `@zubra/sync` and `@zubra/sync/connect` in the page, so `'use collection'` needs no setup. When it isn't installed, the page fails as it's built, naming the component and `npm install @zubra/sync`; `@zubra/unplugin` says the same at build time. `createZubra({ imports })` adds import map entries for other packages.
- **`examples/standup`**: a local-first team board on plain Node: `'use collection'` cards, presence, offline edits, a SQLite log, tested with two browsers.
- **The playground and the docs show both.** Two playground examples, "State on the device" (a note kept in IndexedDB through a reload, shared by every preview) and "A server function" (submitting says what would be posted), a **Server** tab with `--emit server`'s output, and `#example=<name>` links. Guide chapters 9, [Forms that post to the server](docs/guide/09-server-actions.md), and 10, [State that lives on the device](docs/guide/10-local-state.md); the actions and sync pages in the docs site's navigation; and a section on the landing page.

- **Three documentation pages** written against a critical reading of the README. [TypeScript in `.zb` files](docs/typescript.md): the erasable-syntax rule, what it refuses and the rewrite for each, and what reaches the typings and manifest. [Compared with Lit and Stencil](docs/compared-with-lit-and-stencil.md): where each is the better choice, with the one architectural fork (generated per-framework packages against one shared adapter) and sizes measured on the same component. [Server rendering, honestly](docs/server-rendering.md#hydration-markers-through-minifiers-and-sanitizers) gains the hydration-marker contract, measured: which minifiers keep the `<?zb …?>` markers as shipped (html-minifier-terser, @minify-html/node), which need one option (@swc/html, htmlnano, with the option), and which strip them (DOMPurify, sanitize-html), leaving the element to put them back by structure. `server/test/markers.test.js` runs that table in CI.
- **`export interface`, `export type` and `export type { … }` in `<script lang="ts">`.** They're type-only, so the no-exports rule for component scripts no longer refuses them: they're erased from the JavaScript and reach the generated typings exported, as every declaration does. A value export is still an error.
- **`ZUBRA_MARKER_PATTERN` and `ZUBRA_MARKER_DIRECTIVE`** from `@zubra/compiler`, for the two minifiers that strip the hydration markers unless told otherwise: `preserveComments: [ZUBRA_MARKER_PATTERN]` for @swc/html, and the posthtml parser option `directives: [ZUBRA_MARKER_DIRECTIVE]` for htmlnano. The markers test uses them, so they can't drift from what the tools accept.
- **The README says what Zubra is and isn't**: the compiler and runtime are the project; `@zubra/unplugin`, `@zubra/server`, `@zubra/actions`, `@zubra/sync`, the starter, the editor extension and the registry are optional, separate installs, in one table that says when each is needed. The status line explains what the major version counts.


### Changed

- **Compile errors cite the rule they enforce.** A hyphen-less element name points at the HTML spec's definition of a valid custom element name; a `valueChange`-style event name says that a lowercase name is what `on…` attributes, Vue's `@…`, Angular's `(…)` and React 19 can all listen for; each TypeScript refusal points at `docs/typescript.md`. (The README claimed minifiers keep the hydration markers; it now says which do, which need an option, and that sanitizers don't.)
- **An unknown directive in a component script gets a warning, with a hint**: a likely typo gets "did you mean" (`'use colection tasks'` → `'use collection tasks'`), `'use client'` is explained as unneeded, `'use server'` at the top of a script is pointed at exported functions, and anything else lists the two directives Zubra knows and the package behind each. `'use strict'` is still allowed. It still compiles, as it did (a stray directive was ignored before); 6.0 makes it an error.

### Fixed

- **Text alone given to a light-DOM element whose template starts with a condition was lost.** `<x-button>Save</x-button>`, with a template of `<a zb-if={href}>…</a><button zb-else>…</button>`, showed the slot's fallback. The page's text matched the whitespace around the template's condition, so the element took its own children for server markup whose markers had been stripped, and "restored" them. Static text in the template now has to match the markup's words for that to happen. Found building Zubra UI's `action-button`.

## 5.2.0 — 2026-11-09

Plain custom elements: a component as one file with no runtime to install.

### Added

- **`--emit element`: a component as a plain custom element, with no runtime to install.** One module, no imports, built from the same definition as `--emit js`. It covers light-DOM components: props, every template part, `zb-if`, `zb-each`, light-DOM slots kept live under React, Vue, Svelte and Lit, `state`/`computed`/`effect`, lifecycle, form association and scoped styles. Shadow DOM, spreads, `zb-await` and runtime extras such as `resource` and `@zubra/runtime/zag` are refused with a reason. Server hydration and hot reload stay with `@zubra/runtime`. About 5.5 KB gzipped for a small element (the slot code is left out when there are no slots), 7 KB with slots. Also in `zubra request` (`"emit": "element"`) and `@zubra/compiler`. CI runs the runtime's browser suites and the registry's tests on both outputs. See `docs/plain-elements.md`.

## 5.1.2 — 2026-11-09

### Fixed

- **A light-DOM component's own fallback lost its styles after slotted content changed.** When content was added to or removed from any slot, every node in every rendered slot region was marked as slotted (`data-zb-slotted`), the fallbacks included. A component's styles stop at slotted content, so a fallback showing again (`<zb-slot name="title"><h2>{heading}</h2></zb-slot>`) was no longer styled by its component. Only provided content is marked now.

### Tests

- The styles test that checked "a utility class beats the component's styles" passed only because of that bug: the fallback heading had lost the component's rule. The page in that test now declares the layer order first, as Tailwind's output does, and the test also checks that the fallback keeps its own colour. Found while building `--emit element`, whose element runtime didn't have the bug.

## 5.1.1 — 2026-11-09

### Fixed

- **Vue could break reordering a light-DOM component's slotted list.** Vue brackets a `v-for` (any fragment) with two empty text nodes and moves rows through the start anchor's real parent. When the fragment came right after content for a named slot (`<nav slot="side">` then `<p v-for>`), the start anchor joined the named slot, because whitespace goes with the content before it. A keyed reorder then threw "The node before which the new node is to be inserted is not a child of this node", and the rows kept their old order. Empty text nodes now pair up, and both go with the content between them. Whitespace (Svelte) and comments (Lit) keep their rules. Found by Zubra UI's slot test, which runs React and Vue apps that add, remove, reorder and rename slotted children.

## 5.1.0 — 2026-11-09

Dynamic `srcset`, for responsive images from data (a gallery, a CMS, a manifest).

### Added

- **`srcset={…}` and `srcset="… {expression} …"`** compile. Each candidate's URL is checked under the same rule as `src`: on the final value at build time for the HTML output, and on every update at runtime, where one unsafe candidate (`javascript:`, `data:`, `//host`) removes the whole attribute and is reported. An empty value (a prop's `""` default) leaves the attribute off, quietly. It used to be the compile error "dynamic srcset is not supported yet". The runtime exports the check as `isSafeSrcset`.

### Fixed

- **A spread checks `srcset` too.** `{...attrs}` with an unsafe `srcset` candidate is refused (in the HTML output, a compile error; at runtime, the attribute is left off and reported). Before, a spread wrote `srcset` unchecked.

### Compatibility

Output compiled by 5.1 runs on a 5.0 runtime: a 5.0 runtime sets a dynamic `srcset` without checking its candidates (browsers don't run `javascript:` from `srcset`, but update the runtime for the check).

## 5.0.3 — 2026-11-08

A documentation site, a landing page, a logo, and the VS Code extension on the Marketplace. Two diagnostics say more, and the language server finds the compiler in your project. No API changes.

### Changed

- **Two diagnostics taught the wrong thing.** Assigning to a misspelled name (`cnt = 1` for `count`) is now reported as an unknown name with a did-you-mean, not as "can't be assigned". The "can't be assigned" error says how to fix it. Browser globals such as `location = "/"` aren't reported as unknown.

### Fixed

- **The language server finds `@zubra/compiler` in the project you're editing.** It looked only beside itself, so in the VS Code extension (where the server lives in the extension's folder) it never saw a workspace's `@zubra/compiler` and needed the `zubra` command on the `PATH` for diagnostics, completion and hover. It now looks in the nearest `node_modules` above the workspace folder first, then beside itself, then falls back to the CLI.

### Added

- **A documentation site** at `<base>docs/` on GitHub Pages: the guide, the topics, the README as the reference, the changelog, the migration notes and the standards reports. A link to a file that doesn't exist fails the build, and code is coloured.
- **A landing page** at `<base>`, built with Eleventy with the docs. It shows the real compiler output for one component (compiled when the page is built), the same component written by hand, and the demo gallery. Its own Copy button is a Zubra component.
- **A logo** (`brand/`): the mark, an on-dark mark and a tile, used for the favicon and the docs.
- **`docs/guide/08-read-the-output.md`**: reads one component's real output through nine rules of the platform's custom elements, and ends with "change one line, read the diff".
- **`docs/editor-support.md`**, a file icon for `.zb` files in the VS Code extension, and the extension as a package: `npm run package` in `editors/vscode` builds a `.vsix` with the published language server in it. It is on the Marketplace as `JourneytoCode.zubra`.
- **The playground colours** the `.zb` source, the page HTML and the compiled output, and its header links the docs site.

### Tests

- The hydration-dependent browser tests that flaked (Firefox stripped markup, WebKit's React adapter, SvelteKit workouts) wait for `:state(hydrated)` before they click.

## 5.0.2 — 2026-11-08

Packaging fixes found on the first publish. No code changes.

### Fixed

- **Commands in published packages.** npm 11 drops a `bin` written as `"./cli.js"` when it publishes. `create-zubra`, the `zubra` CLI (`@zubra/compiler`) and `zubra-language-server` would have installed without their commands. The bins are now written `"cli.js"`, and a test keeps them that way.
- **`@zubra/compiler`'s tarball on Windows.** Its `prepack` was a `node -e` one-liner whose filter `cmd.exe` mangled, so `registry/test/` was packed. It's now a script file (`compiler/scripts/prepack.mjs`), and `files` excludes `registry/test` as well.
- **`@zubra/compiler` can't be packed without `zubra.wasm`.** `prepack` stops with an error instead of publishing a compiler that can't compile. This was meant for 5.0.1 but missed its merge.

### Tests

- The stripped-markup hydration test waits for `:state(hydrated)` before clicking. `remark.js` loads on demand, and CI could click first.

## 5.0.1 — 2026-11-08

A fix for Astro builds, plus the demo gallery and examples with the styling libraries people use. No API changes.

### Fixed

- **Astro: the server build couldn't find `zubra.wasm`** when `@zubra/compiler` was linked, from a workspace or a `file:` dependency. Vite bundled the compiler into Astro's prerender chunks, so it looked for `zubra.wasm` there. The integration now keeps the compiler external in every server environment (`resolve.external`), including Astro's own `prerender` environment.

### Added

- **A demo gallery on GitHub Pages** (`demos/`):
  - the playground (now at `/playground/`);
  - live builds of the static examples;
  - a screenshot of every example, also at the top of each example's README.

  `demos/build.mjs` builds it, and a CI job checks that every demo loads under the base path.
- **Examples with styling libraries**, each with a browser test:
  - `examples/frameworks/tailwind-cafe` (Tailwind 4);
  - `shadcn-invoices` (React, shadcn/ui and Radix);
  - `mui-clinic` (MUI 9);
  - `bootstrap-devday` (Bootstrap 5 and Sass).

  `docs/guide/styling-libraries.md` covers how components get an app's styles in light and shadow DOM, for each library.
- **Lockfiles for `examples/todo`, `examples/planner` and `examples/recipes`.** The Astro and Eleventy examples now take a `DEMO_BASE`.

### Changed

- **CI:**
  - the gallery check builds with the WebAssembly compiler, as the Pages deploy does;
  - the focus-timer job caches Electron's binary and retries its download.

## 5.0.0 — 2026-11-08

The platform's markers (`plan/roadmap-5.0.md`). The server markup's hydration markers are processing instructions instead of comments. Components and APIs don't change; update the packages together (`docs/migrating-to-5.0.md`).

### Changed

- **Hydration markers are processing instructions:** `<?zb [?>` … `<?zb ]?>` for a region, `<?zb [??>` for a region left to the browser, `<?zb [!?>` for supplied slot content, and `<?zb ?>` before dynamic text. They were `<!--[-->`, `<!--]-->`, `<!--[?-->`, `<!--[!-->` and `<!---->`.
  - The Rust HTML output, `@zubra/compiler`'s `render()`, `@zubra/server` and the framework wrappers' server rendering all write them.
  - Chrome and Edge 150+ parse them as `ProcessingInstruction` nodes; other browsers parse them as comments (`<!--?zb [?-->`). The runtime reads both.
  - The runtime still reads 4.x's comment markers, for all of 5.x, so servers and runtimes can be updated in either order.
  - Client templates (the compiled module's `template`) keep the comment form: the runtime parses them itself.
- **Streaming uses `<template for>`.** A pending region is a named range (`<?start name="zb-0-0"?>`…`<?end?>`), and each resolved region arrives in a `<template for="zb-0-0">`.
  - Chrome and Edge 150+ put it in place themselves, without JavaScript.
  - The inline script hands the element the value, and puts the region in place where the browser didn't: other browsers, and shadow roots, which a `<template for>` can't reach.
  - An element that starts before its region arrives removes the range's name, so the browser has nothing to replace, and renders the region itself.
  - It replaces 3.3's `<template data-zb-swap>`.
- **The compiled code's interface is `abi: 3`.** A 4.x runtime refuses 5.0 modules, with an error that says to update it, because it can't read 5.0's markers. The 5.0 runtime still runs modules compiled by 3.x and 4.x (`abi: 2`).
- **Range positions count elements and markers only.** A comment or processing instruction that isn't a marker, such as a stream's `<?start>`, doesn't shift the paths after it.

### Fixed

- **Streamed regions with content after them.** The server took the region's HTML from its opening marker to the end of the host, not to its closing marker. With more than one pending region the swap could put the wrong content in place.

### Removed

- **Workarounds the markers no longer need:**
  - the Eleventy example minifies with plain `removeComments: true`;
  - the htmx example no longer deletes `Document.parseHTMLUnsafe`, which drops comments in Chromium and keeps processing instructions.
  - `ZUBRA_MARKER_COMMENT` stays, for a 4.x server's markup.

### Tests

- `runtime/test/browser/markers.test.js`: hydration in place from the three marker forms (processing instructions, the comments other browsers make of them, and 4.x comments), and from minified markup.
- `@zubra/server`: no-JavaScript streaming in Chromium, and the script's fallback for a shadow root and for markup parsed as comments.
- The help desk's streamed activity appears without JavaScript in Chromium.

## 4.3.0 — 2026-11-08

The rest of the template sugar (`plan/roadmap-4.x.md`, 4.3). Additive.

### Added

- **`let:name={…}` on `<zb-each>` and `<zb-then>`** names an expression for the row or the result:

  ```html
  <zb-each items={cart} as="{ price, qty }" let:total={price * qty} let:big={total > 5}>
    <li class:big={big}>{total}</li>
  </zb-each>
  ```

  - It's derived: each read is its current value, so it follows the row.
  - It's read-only: assigning it is the same error as assigning a loop variable.
  - Later `let:`s can use earlier ones, and the key can use them too.
  - The server evaluates them for values known at build time; a `let:` the server can't evaluate leaves the list to the browser.
  - On any other element, `let:` is an error.
- **`<zb-switch value={…}>`** with `<zb-case is="paid">`, `<zb-case is={["shipped", "delivered"]}>` and an optional final `<zb-else>`.
  - The first case whose `is` equals the value, or whose array lists it, renders.
  - It compiles to the `zb-if` chain it stands for (`===`, and `||` for an array), so known values render on the server and the markers don't change.
  - A quoted `is` is a string.
  - Errors cover: other content in the switch, a case after the `zb-else`, no cases, an empty `is={[]}`, and a stray `<zb-case>`.
- **Tools and examples:**
  - the language server and the grammar know `zb-switch`, `zb-case` and `let:`;
  - the README, the guide's templates page and the skill describe them;
  - the planner's event tabs are a `zb-switch`.

## 4.2.0 — 2026-11-08

Async that reads well (`plan/roadmap-4.x.md`, 4.2). Additive: every 4.1 component compiles and runs as before.

### Added

- **`<zb-pending>`** names `<zb-await>`'s pending content. Content written straight inside still works the same way.
- **`<zb-await {user}>`** is short for `value={user}`.
- **An array value** (`value={[user, posts]}`) waits for every promise and resource in it, as `Promise.all` does, and resolves to the array of their values. Any rejection goes to `zb-catch`. The value is evaluated again only when what it reads changes, so a resource settling doesn't call `posts()` again.
- **Destructuring in `as`**, on `zb-then`, `zb-catch` and `zb-each`, and for the item of `.map()` in braces:
  - for example `as="[{ name }, list]"`, `as="{ message }"` or `as="{ id, address: { city } }"`;
  - names, renames, nesting and holes work;
  - defaults and rest elements are errors that say why;
  - each name reads through the row's or the branch's signal, so it stays reactive, and a value known at build time is destructured on the server.
- **`retry()`** in `zb-catch` refreshes the value's resources and evaluates the value again.
- **`delay={ms}`** shows the pending content only once the value has been pending that long. Until then the previous content stays, or nothing the first time.
- **`keep`** keeps the settled content while a resource reloads, instead of showing the pending content again. The host has `:state(loading)` meanwhile.
- **Tools and examples:**
  - the language server and the grammar know `zb-pending`, `delay` and `keep`;
  - the README, the guide's async page and the skill describe all of this;
  - the help desk's recent activity and the recipe reviews use `<zb-pending>`, and the reviews retry on an error.

## 4.1.0 — 2026-11-07

Conditions without wrappers (`plan/roadmap-4.x.md`, 4.1). Additive: every 4.0 component compiles as before, unless it has a `zb-` attribute on an element, which 4.0 silently ignored.

### Added

- **`zb-if`, `zb-else-if` and `zb-else` as attributes:**

  ```html
  <p zb-if={count === 0}>Nothing yet.</p>
  <p zb-else-if={count < 5}>A few.</p>
  <ul zb-else>…</ul>
  ```

  - A condition goes on one element. `zb-else-if` and `zb-else` go on the siblings right after it (whitespace may come between).
  - It compiles to the same thing as the `<zb-if>` wrapper, which stays, for conditions over several siblings or over text.
  - It keeps tables and lists valid HTML for editors and formatters (`<tr zb-if={…}>`).
  - Errors that say what to write: on a directive, on the host, without a sibling to follow, after the chain's `zb-else`, quoted, without a value, or two on one element.
- **Markup in braces**, in the three forms that are directives:
  - `{a && <p>…</p>}` is a `zb-if`;
  - `{a ? <b>…</b> : <i>…</i>}` is a `zb-if` with a `zb-else` (either side may be text, an expression or `null`);
  - `{list.map((item, i) => <li key={item.id}>…</li>)}` is a `zb-each`, keyed by the element's `key`.

  The markup inside is the template's own HTML: directives, modifiers, `class:` and nested braces all work, and each brace holds one element. Anything else with markup in it is an error naming the form or directive to use. So is markup in an attribute's braces, which 4.0 reported as a parse error.
- **Tools:**
  - the language server completes `zb-if`, `zb-else-if` and `zb-else` on any element;
  - the VS Code grammar highlights them as directives, and a tag inside braces as a tag;
  - the guide's templates page, the README and the `zubra-component` skill describe both forms (the skill keeps directives as the house style for markup in braces);
  - the playground has a Conditions example.

### Changed

- **The `zb-` attribute prefix is reserved.** An unknown `zb-…` attribute is an error with a suggestion (`zb-iff` → "did you mean `zb-if`?"), and a host attribute can't start with `zb-`. `data-zb-*` stays yours.
- **The examples and the registry use the attribute form** where a `<zb-if>` wrapped one element on its own lines: 56 wrappers in 40 components, compiling to the same output apart from the whitespace that was inside the wrapper. `examples/stats.mjs` counts what's left (9 wrappers, around several siblings or inline).

## 4.0.0 — 2026-11-07

**mnx is now Zubra.** The only change in this release is the name (`docs/migrating-to-4.0.md`). The npm scope `@mnx` belongs to someone else, so the packages could never have been published under it. Nothing had been published yet, so this was the cheapest time to choose a name the project can own everywhere. The format, the runtime's behaviour, the compiled code's ABI and every API are those of 3.6.0.

### Changed (breaking)

- **Files:** `.mnx`, `.mnx.jsx` and `.mnx.tsx` are now `.zb`, `.zb.jsx` and `.zb.tsx`.
- **Directives and attributes:** `<mnx-if>`, `<mnx-each>`, `<mnx-slot>`, `<mnx-await>` and the rest are `<zb-…>`; `mnx-props` is `zb-props`, and `data-mnx-*` is `data-zb-*`. Class names derived from tags follow the tag (`ZbPicker`).
- **Packages:** `@zubra/runtime`, `@zubra/compiler`, `@zubra/unplugin`, `@zubra/server`, `@zubra/language-server` and `create-zubra`; the crate is `zubra`.
- **Commands and variables:** the command is `zubra`, the environment variables are `ZUBRA_*`, and the served assets are at `/_zubra/`.
- **Names in APIs:** `ZubraModel` (Angular), `createZubra()`, `res.locals.zubra` and `request.zubra`.
- **Skills:** the coding-agent skills are `zubra-component`, `zubra-consume`, `zubra-cli` and `zubra-server`.
- **The repository** is https://github.com/journey-to-code-org/zubra.
- No aliases for the old spellings: nobody outside the project used them.

### Fixed

- **The crate ships only the compiler:** 51 files, about 210 KB, down from 797 files and 1.1 MB. It used to include the examples and the npm packages.
- **`@zubra/unplugin`'s peer dependencies** named the 2.x compiler and runtime (`^2.0.0`), so npm would have refused to install it next to 3.x. They are now `^4.0.0`, and `scripts/bump-version.sh` keeps them in step.

## 3.6.0 — 2026-11-07

Accessible primitives (`plan/roadmap-3.5.md`, 3.6). The Zag.js spike showed that the platform does most of what a headless library is for, that two keyboard behaviours are missing, and that Zag covers the hard widgets once spread exists. This release ships each of those.

### Added

- **`@mnx/runtime/primitives`** (1.0 KB gzipped): `rovingFocus(container, { selector, orientation, loop, onMove })`, one tab stop for a group with arrow keys, Home and End between the items (it skips disabled and hidden items and swaps Left and Right in RTL), and `typeahead(container, { selector, text, timeout, onMatch })`, type a letter to jump to an item. Both work on any element in any framework and return their cleanup.
- **`@mnx/runtime/zag`** (0.3 KB): `useMachine(machine, props)` runs a [Zag.js](https://zagjs.com) machine in a component, and `normalizeProps` comes with it. The props function is read whenever Zag asks, so it can read state and props. The service is read reactively, so `computed(() => x.connect(machine.current, normalizeProps))` stays current. Each connection gets a fresh machine, because a stopped Zag machine can't be restarted, so moving the element keeps working. `@zag-js/vanilla` is an optional peer dependency.
- **Five registry components**, each tested by role, accessible name and keyboard (the registry now has 25):
  - `accordion-panel`: `<details>`; the same `group` gives an exclusive accordion.
  - `tool-tip`: `popover="manual"`, `aria-describedby` on the trigger; shown on hover and focus after `delay`; Escape hides it without moving focus.
  - `tab-list`: `rovingFocus`, automatic or `manual` activation; the slotted `data-tab` elements become labelled tab panels.
  - `dropdown-menu`: `popover` with `popovertarget`; Up and Down open it, arrows and typing move, focus returns to the button, Tab closes it, and it fires `itemselect`.
  - `combo-box`: Zag's combobox through `@mnx/runtime/zag` and spread; a form control.
  - `tool-tip` and `dropdown-menu` use CSS anchor positioning, and place themselves with script where it isn't supported.
- **`mnx add` says which npm packages a component imports**, and how to install them. `registry/index.json` lists them under `packages`.
- **The guide: [Accessible widgets without a headless library](docs/guide/accessible-widgets.md)**. It maps Radix and shadcn/ui to the platform, the primitives, a registry component or Zag, and gives what each path costs.
- **`mnx build --lib` lists the npm packages its components import as peer dependencies**, with the project's own version range where it lists one (`@zag-js/combobox` and `@zag-js/vanilla` for a library with `combo-box`).
- The registry's tests run in Firefox and WebKit in CI as well, because the widgets rely on newer platform features. All 25 components hydrate in place from stripped server markup.
- The test harness takes extra import-map entries (`useBrowser(components, files, imports)`).

### Changed

- The example library (`examples/frameworks/ui/`) and the plugin's library test build the registry's components that have no npm dependencies. That leaves out `combo-box`, so their apps and the plain page don't need Zag.

## 3.5.0 — 2026-11-07

Spread (`plan/roadmap-3.5.md`, 3.5). Two findings pointed at the same gap: `mnx convert` stopped at a spread in nearly every shadcn/ui component, and the Zag.js spike needed a `ref` callback for every part of its combobox. Both now go through one feature.

### Added

- **`{...object}` in a start tag**, in `.mnx` and JSX: an object's entries as an element's attributes, listeners and properties, the way headless libraries hand out behaviour (`<input {...api.getInputProps()}>`).
  - **Listeners:** `on<Name>` functions are listeners, replaced when the function changes and removed with their key.
  - **Properties:** `value`, `checked`, `selected` and `indeterminate` are set as properties; `className` and `htmlFor` mean `class` and `for`.
  - **Classes and styles:** `class` merges token by token with the element's own classes and `class:` toggles; `style` is an object set through the CSSOM.
  - **Values:** `true` is a bare attribute; `aria-*` booleans are written as `"true"`/`"false"`; `false`, `null` and `undefined` remove the attribute; entries that disappear are removed.
  - **Precedence:** an attribute written on the element wins.
  - **Refused:** text handlers, `style` text, unsafe URLs and markup keys (`innerHTML`, `srcdoc`, `children`, …). Nothing a spread does could not be done by an attribute.
  - **Server:** a spread known at build time renders, with the same checks; one known only in the browser is left for the element.
  - **Not allowed** on the host, a directive or an imported mnx component, each with an error that says why.
  - **Where the code lives:** `@mnx/runtime/spread` (1.4 KB gzipped), which a compiled module imports only when its template spreads, so the main runtime is unchanged (12.9 KB). An import map needs its entry; `@mnx/server`, the playground and the Flask example have it.
- **`mnx check`: a runtime hook used without its import is an error**, with the import to add (`computed`, `emit`, `onMount` and the rest). It would have thrown in the browser. Every component in the repository passes.
- **TypeScript in a `.mnx.tsx` template expression** (`(e.target as HTMLElement)`, `a!`) is stripped, like the script's.
- The playground has a spread example.

### `mnx convert`

- A spread onto an element is an mnx spread, not a report; a spread onto another component is reported.
- `...props` spread onto the returned element is dropped: the host carries the consumer's attributes. `className` becomes the host's own `class`. The props' React type goes.
- A component built on a third-party React primitive (Radix, Headless UI, React Aria, Ark, Base UI, cmdk, vaul, sonner, Recharts, …) is refused up front, with what to use instead.
- Fixed: an insertion at the edge of a removed span was dropped (`useMemo(() => { … }, deps)` lost its `)()`); a file's other components were checked as if they were converted; removing them left blank lines.
- **shadcn/ui, re-measured** (`docs/convert-measured.md`): 50 of the 68 components in its plain-markup files convert and compile (0 in 3.2); its 46 primitive-based files are refused with one message each.

## 3.4.0 — 2026-11-07

Evidence (`plan/roadmap-4.0.md`, 3.4): the claims the pitch rests on, with numbers, written for the people who argued against them.

### Added

- **`docs/standards/one-source-n-consumers.md`.** The argument for one source made as the weaker claim it has become now that agents make ports cheap: N copies are N things to review and keep matching, and what goes wrong in a port is what the compiler generates. With numbers: the registry's 20 components across the matrix are 140 hand-written ports against 20 files and 367 lines of adapter written once; the ten framework-specific bugs the adapters absorbed, each fixed once; and an experiment (`docs/standards/ports-experiment/`, reproducible) in which an agent ported three registry components to React, Vue and Svelte in three minutes, a reviewing agent found 47 behavioural differences in the nine fresh ports (form reset and submission, event semantics, host semantics: the generated parts), and two fixes were then propagated to all six affected ports without error. The conclusion is the one the survey's instructor would accept: propagation is solved; divergence happens at port time.
- **`docs/framework-matrix.md`**: what each framework's row in CI proves, row by row, and what isn't in a row (SvelteKit with light DOM, Next.js elements with React children, Qwik).

### Corrected

- **React 18 prop timing was already fixed.** `progress.md` listed "React 18: props still arrive after the script runs" as open; since 2.8 the element reads the React wrapper's `mnx-props` when it starts, before React 18's effect sets properties, and `runtime/test/browser/adapters.test.js` asserts a script seeded from a prop sees it under React 18. No change was needed; the roadmap's decision 2 is moot.

## 3.3.0 — 2026-11-07

The last server gaps (`plan/roadmap-4.0.md`, 3.3): "SSR isn't great with web components" was the belief two of the survey's nine respondents held, and three visible gaps confirmed it.

### Added

- **Light DOM under framework hydration**, for an element given no framework children. The React and Vue wrappers (`@mnx/runtime/react`, `@mnx/runtime/vue`) render an element's content into its host on the server (a light-DOM element's rendered children; a shadow-DOM element's declarative shadow root, as since 2.11) and keep the framework out of the host while hydrating (React: `dangerouslySetInnerHTML` with an empty string in the browser and `suppressHydrationWarning`; Vue: a vnode with no children at all, so Vue never looks inside), so the element hydrates its markup in place. `serverContent(Element, { props, name })` from `@mnx/runtime/server` is the function behind both (`shadowContent` remains, for shadow DOM only). `@mnx/server`'s `injectShadowRoots(html, { lightDom: true })` does the same for frameworks that leave nodes they didn't render alone (Solid). The React Router balance list, the Nuxt stock meter, the Next.js session card and the SolidStart dish board are light DOM now, with their no-JavaScript tests passing. Still `shadow`: an element given React or Vue children, and every component under SvelteKit. `@mnx/unplugin`'s warning says which.
- **Streaming.** In `@mnx/server`, a prop given as a promise renders as pending (the compiler's new `pending` request field: the prop is unknown, so its `mnx-await` shows the pending content in an empty region), and `page.stream(html)` (a Node stream) or `page.streamResponse(html)` (a web `Response`) sends the page first, then, as each promise settles, a `<template>` with the resolved region and an inline script that swaps it in before the element starts (or hands the element the value if it has; a held promise keeps the `mnx-await` pending meanwhile; a rejection reaches `mnx-catch`). The streamed page's module script is `async`, so the elements start before the stream ends. `page.pending` says whether a page is streaming. The help desk's dashboard streams its recent activity (`components/recent-activity.mnx`).
- `HtmlOptions.pending` in the Rust API; `--emit interface` typings carry `required`.

### Documented, not fixed

- **Next.js elements given React children** can't carry server-rendered content: `dangerouslySetInnerHTML` and children are exclusive in React, and a declarative shadow root as a React child breaks hydration. They draw in the browser until React understands declarative shadow DOM. `docs/server-rendering.md` records it.

## 3.2.0 — 2026-11-07

Usable by agents (`plan/roadmap-4.0.md`, 3.2): the thing the survey said nobody had asked a web-component tool for yet.

### Added

- **Mutating state updates the DOM.** `let items = []` then `items.push(x)`, `items.splice(i, 1)`, `items[0].done = true`, `form.email = "…"`, `delete form.email`: a `let` (or `state()`, or `from()`) holding an array or a plain object holds a reactive proxy, with a `Signal.State` per property, so a write re-runs only what read that property (`runtime/src/deep.js`, about 370 B gzipped). Nested arrays and objects are wrapped as they're read; class instances, `Map`, `Set`, `Date`, DOM nodes and functions aren't. `raw(value)` from `@mnx/runtime` gives the original back. Props aren't wrapped. `mnx-each` reads the list's length and indices, so pushes and splices re-run it and keyed rows keep their elements. The compiler's output is unchanged. (`plan/decisions/deep-reactivity.md`.) The runtime's gzip budgets are 13.5 KB (development) and 13 KB (production), up from 13 / 12.5.
- **`skills/`**: `mnx-component` (writing one), `mnx-consume` (using one from each framework), `mnx-cli`, `mnx-server`, each written so an agent can do the job from it alone, and **`AGENTS.md`** naming them. `skills/test/skills.test.js` compiles every component example in them and checks the copies; `skills/test/agent.test.js` has an agent write a component from the skill alone and checks it compiles, renders on the server and works in Chromium (run with `MNX_AGENT="claude -p"`; a non-blocking CI job where `ANTHROPIC_API_KEY` is set).
- **`npm create mnx` writes `AGENTS.md` and `skills/`** into the new project; **`mnx build --lib` writes `skills/using-<package>/SKILL.md`** from the manifest, so a library tells agents its components' props, events, slots and two-way bindings.
- **`mnx convert`**: `useReducer` becomes a `let` and a `dispatch` that assigns; `createContext` and `useContext` become the runtime's (`inject()`), with `<Context.Provider>`, exported contexts and contexts from other modules reported; a received event prop passed on (`onClose={onClose}`) becomes a call; `--component <Name>` converts one of a file's several exported components (`export function X` or `export { X }`); `--as mnx` writes the HTML-first `.mnx` file, with the script as written and the template's indentation, once nothing is left to finish. `docs/convert-measured.md` runs it over shadcn/ui's 325 components: 0 convert without a hand finish, 323 because of spread props, which is the next thing to build.
- `--emit interface` includes `required` per prop; `scripts/sync-skills.sh`.

### Examples

- The trail filter and the recipe reviews mutate their lists instead of rebuilding them; the scoreboard counts "a let rebuilt instead of mutated" (0).

## 3.1.0 — 2026-11-07

Who this is for (`plan/roadmap-4.0.md`, 3.1). The first release whose evidence is what people who don't use web components said, rather than what building the examples took. Nothing in the compiler or runtime changed; the positioning did.

### Added

- **`docs/who-this-is-for.md`**: where a compiled web component earns its place (a library or design system with consumers on more than one stack, components handed to other people's stacks, a CMS or an older app, a server that isn't JavaScript) and where it doesn't (one app on one framework, a container of the app's own components, one button on one page). The honest objections, with where mnx stands on each.
- **`docs/what-crosses-the-boundary.md`**: what crosses a custom element (props, events, two-way binding, slots, form participation, the Context Protocol, host refs, server rendering, outside styling) and what doesn't (render props, framework context, Suspense and transitions, framework hooks, the consumer's components by name), with the rule of thumb: a leaf fits, a container belongs in the framework.
- **`docs/server-rendering.md`**: the server story in plain terms, with what renders where, what works without JavaScript, and the four gaps that remain (light DOM inside hydrating frameworks, Next.js elements with React children, no streaming, `Date`/`Intl` browser-only).
- `scripts/bump-version.sh`.

### Changed

- **The README's first screen** is the copy button from the conversation that started this roadmap, next to the same element written by hand (about 55 lines, in a `<details>`), then `let count = 0` updating one text node, then "who it's for" with the Astro line: Astro lets frameworks coexist on a page; mnx lets one component be used by all of them. The framework matrix moves below.
- The guide's first page says in one sentence that the button renders in light DOM and shadow DOM is a flag.

## 3.0.0 — 2026-11-07

The first major version since 2.0 (`plan/roadmap-3.0.md`). One change in meaning, one removal; `docs/migrating-to-3.0.md` has the upgrade. Compiled code is unchanged (`abi: 2`), so components built with 2.x run on the 3.0 runtime.

### Changed (breaking)

- **A signal `const` in a script means its value**, as it already did in templates. A `const` holding a signal from `state()`, `computed()`, `inject()`, `hasSlot()` or `hydrated()` reads as `.get()` wherever the script names it, and a `const` derived from it stays in sync. `count.get()` and `count.set(…)` written out keep working, and `signal(count)` is the signal itself. Only 2.x code that passed the signal itself changes meaning (`watch(count, …)`, `formValue(count)`): run `mnx migrate --to 3` once, on the 2.x code, to wrap those in `signal(…)`. `--check` now lists each place. 2.6–2.11 warned at each; in this repository it touched two runtime test fixtures.
- **The CLI's 1.x name, `mnix`, is gone.** `@mnx/unplugin` and the language server no longer fall back to it.
- **`@mnx/server` needs `@mnx/compiler` and `@mnx/runtime` 3.**

### Unchanged

- The hydration markers, and `<mnx-each>` as the way to write lists.
- **Browser support: the target is Baseline 2026, and no fallback was dropped.** `moveBefore()` isn't in Safari, `ElementInternals.states` isn't Widely available yet, and no browser ships TC39 Signals. `docs/browser-support.md` lists them.

### Examples and docs

- The planner's event page reads its `computed()` event as a value.
- `docs/migrating-to-3.0.md`; the README, the guide's props page and the runtime's `signal()` docs describe 3.0's reads.

## 2.11.0 — 2026-11-07

Next.js in the SSR bridge (`plan/roadmap-3.0.md`, 2.11). All additive.

### Added

- **Shadow roots in Next.js's server HTML.** Next streams React Server Components and has no hook for its HTML, so `@mnx/server`'s `injectShadowRoots` can't reach it. Now the React wrapper writes the shadow root itself, for a shadow-DOM element with no React children: on the server, the host's inner HTML is its declarative shadow root (and a form control's fallback input). The browser attaches the shadow root while parsing, and React doesn't hydrate inner HTML. In the browser that inner HTML is an empty string, which React leaves alone. The conference app's cards show without JavaScript, and the elements keep the parser's nodes when they start.
- **The loader's server build.** `@mnx/unplugin/loader` with `options: { server: true }` (a Turbopack rule with `condition: { not: 'browser' }`) registers how to render each component on the server, with `@mnx/compiler` from the component's embedded sources. `README.md` has the `next.config.mjs`.
- **`shadowContent(Element, { props, name })`** from `@mnx/runtime/server`: a shadow-DOM element's server-rendered shadow root and form fallback, for framework integrations.
- An element's `mnx` description says which prop is its model (`props[name].model`).

### Fixed

- **`injectShadowRootsStream()` could give a host a second shadow root** when a chunk ended right after the host's start tag and the next began with a shadow root the page already had ("A second declarative shadow root cannot be created on a host"). It waits for more of the stream after a host's start tag now. With the React wrapper rendering shadow roots in React Router's server build too, that case became common there.

### Not covered

- An element given React children (slot content) still draws in the browser under Next.js. A `<template shadowrootmode>` as a React child breaks hydration (React finds a different child, reports #418 and re-renders the page). The spike that found it is in `plan/roadmap-3.0.md`.

## 2.10.0 — 2026-11-07

Hydrating stripped pages, and props for Svelte and Solid (`plan/roadmap-3.0.md`, 2.10). All additive.

### Added

- **Server markup whose comments were stripped hydrates in place.** HTML minifiers (`removeComments`), some sanitizers and htmx in some browsers remove mnx's hydration markers. Before, such an element rendered fresh with a warning, losing focus and input state. Now it puts the markers back by structure and hydrates the markup it has:
  - a text anchor's text runs up to the next element;
  - an `mnx-if` holds the branch the current values choose, and an `mnx-each` one row per item, each checked element by element;
  - a light-DOM slot that ends its range holds the rest: its fallback if it has the fallback's shape, the supplied content otherwise;
  - an empty region followed by what follows it in the template is one the server left to the browser.

  Where that can't be placed for sure (an `mnx-await`, content projected into a child component), the element renders fresh as before, with the warning. The code is a separate module, `remark.js`, loaded only when an element meets such markup, so the runtime's size is unchanged where it isn't needed. All 20 registry components hydrate in place from stripped markup (`registry/test/stripped.test.js`), and so do the Eleventy guide's naively minified build and the bike shop's htmx swaps without the parser fix.
- **`mnx-props` for Svelte and Solid.** `@mnx/unplugin` adds it to mnx hosts in Svelte and Solid server builds, from the attributes that set the element's props (`log={…}`, `{log}`, `bind:value={…}`, Solid's `prop:items={…}`). The SvelteKit and SolidStart apps drop their hand-written ones.

### Fixed

- 2.9.0 said Firefox doesn't focus an invalid mnx form control's input when a form won't submit. It does; it only logs "The invalid form control … is not focusable" as it goes. A new test checks the focus in every engine, and `docs/browser-support.md` is corrected. (Its message also comes without a name, "An invalid form control is not focusable", for a control created by script.)
- The page-notes extension's injection test raced the bridge's own sends as the page loaded; it now sends until the bridge is done.

### Changed

- **The runtime has a second module, `remark.js`, loaded with a dynamic import.** Bundlers split it into its own chunk. A single-file Rollup build (`output.file`) can't, so `@mnx/unplugin` sets `inlineDynamicImports` there; a Rollup build of the runtime without the plugin needs it set, or `output.dir`.
- The runtime's size test measures the entry the way a bundler splits it (`remark.js` apart). The development build is 12.9 KB gzipped and the production build 12.5 KB, within their budgets.

## 2.9.1 — 2026-11-07

`from()` across the examples and docs.

### Examples and docs

- Three more components use `from()`:
  - the planner's event dialog: `let problem = from(event, "")` clears its validation message when it opens another event, instead of a line in its `watch()`;
  - the Eleventy trail filter: `let longest = from(max)` starts the slider at the longest trail, and again if that changes;
  - the recipe scaler: `let people = from(servings)` (a JSX component).
- The React, Svelte and Vue guides map their patterns onto it: `useState(prop)` plus a reset effect, Svelte's writable `$derived`, and Vue's `ref(props.x)` plus a `watch()`.

## 2.9.0 — 2026-11-07

The additive part of 3.0, early (`plan/roadmap-3.0.md`, 2.9). Nothing changes meaning.

### Added

- **`from()`** from `@mnx/runtime`: `let left = from(seconds)` is state that follows a prop until it's assigned, and starts over when the prop changes. `let running = from(seconds, false)` starts as `false` instead, again on each change. It works in `.mnx` scripts and JSX components, renders on the server as the prop's value, and a `const` with `from()` is an error that suggests the plain `const`. `mnx convert` turns React's `useState(prop)` plus a `useEffect` that resets it on `[prop]` into `from()`, and drops the effect.
- **A production build of the runtime** (`dist/production/`), without hot reloading. Bundlers pick it through the `production` export condition (Vite and webpack do in production builds), and `@mnx/server` serves it when `NODE_ENV` is `production` (or `production: true`). It's 12.2 KB gzipped, against 12.7 KB for the development build.
- **Firefox and WebKit in CI:** the runtime's browser suite and the React and Vue example apps run in both, through Playwright (`MNX_BROWSER=firefox|webkit`). The runtime's browser suite also runs on the production build (`MNX_RUNTIME=production`). Both engines pass, with three findings recorded in `docs/browser-support.md`: Firefox before 159 can style slotted light-DOM content with its component's `<style>` (a Firefox `@scope` style-sharing bug, fixed in 159); Firefox doesn't focus an invalid mnx form control's input when a form won't submit; and WebKit clears long lists relatively slowly.

### Fixed

- The frameworks examples' test server no longer crashes on a request for a missing file (Firefox asks for `/favicon.ico`).

### Examples and docs

- The Electron focus timer uses `from()` for its time left and running flag, and drops a saved length and a five-line effect.
- The README, the guide's props page and the runtime README cover `from()` and the production build; `docs/browser-support.md` covers the engines tested.

## 2.8.0 — 2026-11-07

Server-first (`plan/roadmap-server.md`, 2.8). All additive.

### Added

- **`@mnx/server`**, a new package for rendering mnx components from any Node.js server. `createMnx({ components })` compiles a folder of components and caches them. `page()` renders components into a page and adds their CSS and module scripts (`finish(html)`). `handle(req, res)` and `fetch(request)` serve the browser modules and `@mnx/runtime`, and `writeAssets(dir)` writes them for a static site. Express, Fastify and Hono have adapters (`@mnx/server/express`, `/fastify`, `/hono`).
- **The SSR bridge for frameworks.** `injectShadowRoots(html)` (and `injectShadowRootsStream()` for a stream) finds the hosts of shadow-DOM components in a framework's HTML and renders their shadow roots into it (`<template shadowrootmode="open">`), from the host's attributes and a `mnx-props` JSON attribute. For a form-associated component with a model prop and a `name`, it adds a hidden input carrying the value, which the element removes when it starts. With it, SvelteKit, Nuxt, React Router and SolidStart pages show their elements and submit their forms before JavaScript. The React and Vue adapters write `mnx-props`; in Svelte and Solid the app writes it.
- **The server evaluates the script's deterministic JavaScript.** Arrow functions, `.map()`, `.filter()`, `.reduce()`, `.includes()`, `toFixed()`, `padStart()`, `Math`, `Object.entries()`, template literals, spread and more now render on the server, in the CLI, `mnx serve` and `@mnx/compiler` alike. What isn't deterministic (`Date`, `Intl`, `Math.random`, `toLocaleString`, anything from `fetch`) is still left for the browser, and `mnx check --server` still lists it. A differential test runs each supported expression in V8 and checks the server agrees.
- **`--emit interface`** (and `emit: 'interface'`): a component's tag, shadow and form flags, props (with attribute names, types, defaults and which is the model) and events, as JSON, for a server.
- **The Turbopack and webpack loader** (`@mnx/unplugin/loader`): Next.js imports `.mnx` files directly as client React components, with no `mnx build --lib` step.
- **`host-reset`** on a shadow host: `:host { all: initial !important }`, so a page's styles (even `!important` ones) don't reach the host. For components on pages you don't control.

### Changed

- **The runtime reads `mnx-props`** when an element starts, and a form-associated element removes its server fallback input.
- **The runtime's size budget is 13 KB gzipped** (it was 12.5 KB) for the above.

### Examples and docs

- The help desk and the Eleventy guide use `@mnx/server` instead of their own compiler glue. The SvelteKit, Nuxt, React Router and SolidStart apps add the SSR bridge, and each one's no-JavaScript test now submits its form. The Next.js app uses the loader.
- The Flask garden computes its checkbox state and chart in the components again, and the Hono price tag formats with `toFixed`. The page-notes widget uses `host-reset`.
- The README and the guide's server-rendering page cover `@mnx/server`, the SSR bridge and what the server evaluates.

## 2.7.0 — 2026-11-07

Progressive enhancement, said once (`plan/roadmap-server.md`, 2.7). All additive.

### Added

- **`hydrated()`** from `@mnx/runtime`: a signal that's `false` in the server's HTML (and on the server) and `true` once the element has started. The host also gets the custom state `hydrated`, for CSS (`:host(:state(hydrated))`, `my-filters:state(hydrated)`). It replaces `let live = false; onMount(() => (live = true))`.
- **`<select value={…}>` and `<textarea value={…}>` in the HTML output.** A select's value marks the matching `<option selected>`, and a textarea's value becomes its content. HTML ignores a `value` attribute on both, so before JavaScript the page used to show the first option and an empty box.
- **The `.submit` event modifier** submits the element's form after any handler, with `requestSubmit()`, so validation and `submit` listeners run. `<select onchange.submit>` needs no handler. In scripts and JSX it's `submit(fn)`.
- **The `.mod` key modifier**: ⌘ on Apple platforms and Ctrl elsewhere (`onkeydown.mod.enter`, `keys('mod+enter', fn)`).
- **`value:bind={x}`** on a child custom element keeps its two-way prop and a `let` (or prop) in step. It stands for `value={x}` plus `onvaluechange={(event) => (x = event.detail)}`.
- **`mnx check --server`** lists what a server without JavaScript leaves out of a component rendered with its defaults (calls, template literals, runtime-only values). It's an error for `checked`, `selected`, `value` and `disabled`, which make a form wrong without JavaScript. It's also `"server": true` on a `check` request, and `npx mnx check --server`.
- **`mnx serve`**: a long-lived process answering one JSON request per line, for servers in other languages. Requests can also be batches (`{ "requests": [ … ] }`). The Flask example uses it, and its pages got about 40% faster.
- **`mnx build --lib --watch`** rebuilds after each change. A compile error keeps the last good build, because builds now go to a temporary directory and are swapped in. The Next.js example has `npm run ui:watch`.
- **`MNX_MARKER_COMMENT`** from `@mnx/compiler`: the hydration markers' comment text, for minifiers' keep-lists.

### Changed

- **Partial rendering decides `live && …` and `!live || …`** (any known first operand of `&&` or `||` that settles the result), instead of leaving the whole expression for the browser.
- **A host whose hydration markers were stripped** gets a warning that says so and names the usual causes (a minifier, a sanitizer, htmx), instead of the general "doesn't match its template".
- **`@mnx/unplugin` recognises React Router as a React project,** so `framework: 'react'` is no longer needed there.
- **`@mnx/unplugin` warns when a light-DOM component is server-rendered in React Router, Nuxt or SvelteKit**, whose hydration breaks around it.
- **The runtime's size budget is 12.5 KB gzipped** (it was 12 KB) for the above.

### Examples and docs

- The help desk's filter bar drops its nine `selected=`, its `ref` and its `apply` function. The reply box drops a listener and its `ref`. Seven components across the help desk, Flask, Hono and Eleventy apps use `hydrated()` instead of the hand-written pattern. The note composer uses `value:bind`.
- The scoreboard (`node examples/stats.mjs`) counts the server and client apps too, and the patterns these replace are now at zero.
- The README covers hydration markers, frameworks that hydrate, and what the server can render. The guide's Forms page covers forms that work before JavaScript, and a new page covers mnx on other people's pages.

## 2.6.7 — 2026-11-07

### Examples

Three more framework apps in `examples/meta/`, each with a Chromium test in CI:
- **`react-router-trips/`**: a shared trip budget in React Router 8's framework mode. It imports `.mnx` files as React components through the Vite plugin, and uses form-associated controls in `<Form>` with a server `action` and a `useFetcher` delete.
- **`solidstart-potluck/`**: a potluck sign-up in SolidStart 2. It uses elements directly with `prop:` and `on:`, as form controls posting to a server `action`.
- **`eleventy-trails/`**: a static trail guide in Eleventy 3. A shortcode renders the components at build time, and a transform adds their CSS and modules, with no bundler. The tests also build it minified, both keeping mnx's markers and not.

What they found (in `examples/meta/README.md`):
- Solid's hydration tolerates light-DOM components, unlike React, Vue and Svelte.
- React Router renders only the host tags, as the other frameworks do, and so does SolidStart.
- An HTML minifier that removes comments removes the hydration markers. html-minifier-terser's `ignoreCustomComments: [/^[[\]?!]*$/]` keeps them.
- The plugin doesn't recognise React Router as a React project, so it needs `mnx({ framework: 'react' })`.

## 2.6.6 — 2026-11-07

### Fixed

- **The esbuild plugin reports compile errors as the compiler wrote them.** Under esbuild and Bun, unplugin's `this.error()` records an error rather than throwing it, and it drops the error when the hook returns nothing. Depending on the file, a compile error came out as "Do not know how to load path" or as a `TypeError`. The plugin now always throws.

### Examples

- **`examples/extension/page-notes/`**: a Chrome extension (Manifest V3).
  - mnx components appear in its popup, its options page, and a shadow-DOM widget on other sites' pages. It also has a service worker for the toolbar badge.
  - Content scripts can't define custom elements (`customElements` is `null` in their isolated world). So the widget runs in the page's own world, and a bridge script passes it data as text.
  - A host's `:host` rules lose to a page's `!important` styles, so the widget's are `!important` too.
- **`examples/desktop/focus-timer/`**: a focus timer in Electron.
  - The renderer is sandboxed and exposes a three-call preload.
  - Its Content Security Policy allows no inline scripts, `eval` or inline styles. mnx works under it unchanged, because component CSS is adopted as constructed stylesheets.
  - Its tests drive the app with Playwright's Electron support and a fake clock.
- CI runs both in a new `clients` job.

## 2.6.5 — 2026-11-07

### Examples

- **`examples/hypermedia/hono-bikes/`**: a bike shop's inventory built with Hono and htmx, running on Node.js and on Bun.
  - Every route answers a plain request with a page and an htmx request with the fragment to swap.
  - The mnx components in those fragments are rendered on the server and hydrate where htmx puts them.
  - Its tests run the server on both runtimes, with JavaScript off and on. CI runs them in a new `hypermedia` job.
- **What it found** (in its README):
  - In the Chromium that Playwright ships, `Document.parseHTMLUnsafe()`, which htmx 2 prefers, drops HTML comments. That includes mnx's hydration markers, so swapped-in elements render fresh instead of hydrating. They come out right, but with a warning. The example works around it so htmx uses `DOMParser`, and a test covers both paths.
  - Custom elements can't be table rows.
  - Formatting money on the server takes arithmetic.

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
