# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): from 1.0.0, the authoring formats, the CLI and the runtime's public API change incompatibly only in a new major version.

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
