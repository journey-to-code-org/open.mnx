# Compared with Lit and Stencil

Lit and Stencil are the two web-component toolchains most teams already know, and both are good. If you are choosing, this page says where each is the better choice and what Zubra trades for what it does differently. It is written to be fair in both directions; where a number appears, it was measured, and the command that measured it is given.

## The one architectural fork

All three produce standard custom elements. They differ on **where the work of being usable from a framework is done**:

| | Lit | Stencil | Zubra |
|---|---|---|---|
| You write | A TypeScript class with `html` tagged templates | A TypeScript class with decorators and JSX | HTML with `{expr}` bindings and a `<script>` (`.zb`), or a JSX function |
| Reactivity | Reactive properties; the class re-renders its template on a microtask, and lit-html diffs | Reactive decorators; a virtual DOM diffs | Signals (the TC39 proposal's API); each binding updates its own node, nothing re-renders |
| Server HTML | `@lit-labs/ssr`: runs the element class against a server DOM shim | Hydrate app: runs the component in a Node DOM and serializes | The compiler renders the HTML itself (Rust or WebAssembly), no DOM on the server; the element hydrates in place by markers |
| Framework use | The element directly; `@lit/react` for React's event quirks | **Generated per-framework packages**: a real React component, Angular module, Vue component per element | **One shared runtime adapter** per framework (`@zubra/runtime/react`, `/vue`, `ZubraModel` for Angular), plus generated typings |
| TypeScript | Full: your `tsc` compiles the file | Full: Stencil runs the TypeScript compiler | Erasable syntax only; type text carried into typings and the manifest, no type checker in the path ([TypeScript in `.zb` files](typescript.md)) |
| Shipped since | 2019 (lit-html 2017) | 2017 | 2026 |

The last row matters and is not an argument: Lit and Stencil have years of production behind them, and that is a real reason to pick either. The rest of this page is about the design choices, because those are what you'd be choosing between once you've decided a young tool is acceptable.

## Where Stencil is better

**Generated native packages.** Stencil's output proxies look and behave like components the framework wrote itself: idiomatic imports, framework-native typings, no runtime adapter in the bundle, and a framework upgrade that breaks the proxy breaks it at build time. Zubra's adapter is one runtime module that every component shares. The trade-off is maintenance scale: Stencil maintains N generated outputs per component; Zubra maintains one adapter per framework and generates only typings and thin wrappers. For a team shipping to exactly React and Angular, Stencil's native output is the smoother consumer experience. For a library whose consumers' frameworks it can't predict, one adapter that absorbs a framework quirk once (the ten the matrix has absorbed are in [One source, N consumers](standards/one-source-n-consumers.md)) is less to maintain.

**A smaller blast radius.** Stencil's framework packages are generated code, fixed when the library is built. Zubra's components in a React app all go through one adapter (`@zubra/runtime/react`; Vue has its own), so a regression in it reaches every Zubra component in every React app that upgrades the runtime, at once. The matrix in CI (`examples/frameworks/`, `examples/meta/`) exists to catch that before a release, but it is a real difference in where a bug can land.

**Full TypeScript.** Stencil owns the TypeScript compiler, so enums, namespaces, decorators and the whole language work, and the generated framework packages have exact types. Zubra deliberately keeps `tsc` out of the compile path; [TypeScript in `.zb` files](typescript.md) says what that costs.

**Lazy loading built in.** Stencil's default output loads each component's code on first use. Zubra's modules are plain ES modules; a bundler can split them, but nothing does it for you.

## Where Lit is better

**Smallest footprint for a few elements, and no file format to learn.** A Lit element is a JavaScript class; the template is a tagged literal in it. There's no compiler, no `.zb`, no editor extension, and the whole of Lit is small. Measured on this README's copy button (bundled and tree-shaken with esbuild `--bundle --minify`, then `gzip -9`; Lit 3.3.3):

| Output | Gzipped |
|---|---|
| Lit: element + `lit` (LitElement, lit-html) | 6.2 KB |
| Zubra `--emit element`: one file, no runtime | 5.2 KB |
| Zubra `--emit js`: the component's module | 0.6 KB, plus |
| `@zubra/runtime` (production build), shared by every component | 13.8 KB |

(Lit's figure is already what's left after tree-shaking. `@lit/reactive-element` alone is smaller, but it has no templates, so it isn't the same component.) So for a page with one or two components, Lit and Zubra's plain output are the same size; for an app that loads the shared runtime, Zubra ships about 8 KB more than Lit does. That 8 KB is the hydration-in-place machinery, the Signals implementation (which steps aside when `globalThis.Signal` exists), light-DOM slots kept live under a framework, the deep-reactivity proxies, and the framework bridge. If you don't need those, Lit is the smaller choice, and so is `--emit element`.

**Templates type-checked against TypeScript.** With lit-analyzer (or its `ts-lit-plugin` in the editor), Lit checks each binding in an `html` template against the property's declared TypeScript type, before anything runs. Zubra checks a template's names (unknown ones, with a "did you mean"), and a child component's props at the call site against the types of the child's defaults, but it doesn't check template expressions against TypeScript types: that's the cost of keeping a type checker out of the compiler ([TypeScript in `.zb` files](typescript.md)).

**Plain JavaScript, no restrictions.** Lit's templates are JavaScript expressions; anything goes. Zubra's `{expr}` is any JavaScript expression too, but the compiler evaluates a deterministic subset on the server and leaves the rest to the browser, and it tells you which is which (`zubra check --server`). That is a constraint you feel.

**Ecosystem.** `@lit/context`, `@lit/task`, `@lit-labs/ssr`, localization, and the components built on Lit (Shoelace/Web Awesome, Spectrum, Material). Zubra interoperates (the Context Protocol is shared, so `@lit/context` values reach `inject()`), but it has a 26-component registry, not an ecosystem.

## What Zubra does that neither does

**HTML-first authoring that compiles to the platform.** A `.zb` file is a template, a script and a stylesheet; the host tag declares the element and its props. The output is readable, and [Read the output](guide/08-read-the-output.md) teaches web components from it. Lit and Stencil are JavaScript-first by design.

**Server HTML without a DOM.** Neither Lit SSR nor Stencil's hydrate app can run outside a JavaScript server. Zubra's compiler renders the HTML in Rust or WebAssembly, so Flask, Rails, PHP and Go render the same bytes Node does (`compiler/test/server-evaluation.test.js` checks the subset against V8). [Server rendering, honestly](server-rendering.md) also lists where this still falls short inside meta-frameworks.

**Hydration in place, not re-render.** The element binds to the server's markup by markers and writes only parts whose values differ. Lit SSR hydrates by re-running the template and reconciling; Stencil re-renders through its VDOM. Zubra's markers are processing instructions, which most minifiers keep and sanitizers strip; the measured contract and what the element does when they're gone is in [Server rendering, honestly](server-rendering.md#hydration-markers-through-minifiers-and-sanitizers).

**Fine-grained updates on a standards-track API.** Every binding is an effect on a `Signal`; `count++` updates one text node. Lit batches a re-render; Stencil diffs. Zubra's runtime carries its own Signals implementation today and is written so that a native one deletes it ([the integration report](standards/signals.md)). Whether the proposal ships is a bet, and it is the stated one.

**Light DOM by default, scoped with `@scope`.** Lit defaults to shadow DOM. Stencil defaults to no shadow DOM and no scoping, with `shadow: true` or `scoped: true` (class-name rewriting) per component. Zubra scopes a component's CSS in light DOM with the platform's `@scope`, so page CSS, Tailwind and native form submission work without a flag and without rewritten class names, and `shadow` is opt-in for isolation.

## Why the compiler knows `'use server'` and `'use collection'` by name

`@zubra/actions` and `@zubra/sync` are separate packages, but the compiler recognises their two directives itself: it strips a `'use server'` function from the browser module and turns `action={save}` into a URL, and it wires a `'use collection'` script's `let`s to a store. The natural objection is that a lean compiler would know no directive names and expose a hook that packages register with, so a third party could add `'use supabase'` without touching the parser. The two design docs for these packages proposed exactly that hook, and it was turned down for one reason: **the compiler is one Rust binary, and it can't call into JavaScript at compile time.** A hook could live in `@zubra/unplugin`, but then the CLI, `zubra serve` and every server that isn't JavaScript (Flask, Rails, Go) would see an unknown directive, and the same `.zb` file would compile differently depending on which front end compiled it. Byte-identical output from every server is the property the server-rendering story rests on, so it won.

What that costs is a short list in the parser (two names today) and a release of the compiler when a sibling adds one. What it buys is that `zubra compile` on any machine, with nothing installed, produces the same HTML and module that a bundler would, and that an unknown directive gets a diagnostic that names the package to install rather than a silent no-op (a warning in 5.x, since a stray directive used to be ignored; an error from 6.0). A general plugin API stays off the table until a sibling needs something a directive can't express; when one does, that is when the hook question reopens. If it does, the shape that keeps the property above is data, not code: a directive declared in a file the Rust compiler reads (its name, where it may sit, which exports leave the browser module, an attribute rewrite such as `action` → `/_zb/action/{tag}/{name}`, imports to add), so that the two directives known today become the first two entries and a third party can add one without a JavaScript phase in the compiler. A plugin that runs JavaScript during compilation can't be that shape: the HTML it produces would differ between a bundler and `zubra serve`, and a transform that rewrites function bodies would break both the server's evaluation of the script and the rule that every part of the output exists because of a rule of the platform.

## The escape hatch is a floor, not a trapdoor

`--emit element` writes a component as one plain custom element with no runtime, from the same definition `--emit js` uses, and CI runs the browser suites on both outputs. It leaves out what needs the runtime (shadow DOM, server hydration, spreads, `zb-await`, hot reload) and refuses each with a reason. That isn't "activating the flag guts the framework"; it's the same component at the size of a hand-written element, for the cases where that's what you want: one file to hand someone, a widget on a page you don't build, a dependency-free publish. [Plain elements](plain-elements.md) has the full list of what each output does.

## Choosing

- **Lit** if you want the smallest, most mature, JavaScript-first element library and your consumers are fine with shadow DOM or your own scoping.
- **Stencil** if you ship to a fixed set of frameworks and want native-feeling packages with full TypeScript, and a JavaScript server (or no SSR) is fine.
- **Zubra** if your components have more than one consumer, you want them written as HTML and rendered on any server, and you'd rather one adapter absorb framework quirks than maintain generated ports. And if you're betting, with the project, that Signals and the rest of what the runtime stands in for will reach the platform.

[Who Zubra is for](who-this-is-for.md) is the fuller version of that last line, including when the answer is "none of these; use your framework".
