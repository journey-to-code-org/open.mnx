# Compared with WebUI, FAST, Enhance and WebC

[Compared with Lit and Stencil](compared-with-lit-and-stencil.md) covers the two toolchains most teams already use. This page covers the four that are closest to what Zubra itself claims: components written as HTML, rendered on servers that aren't Node.js, and hydrated in place. Two of them are Microsoft's: **WebUI** is a server-rendering framework that competes for the same job as Zubra's server rendering, and **FAST Element** is a component library that Zubra components can live beside. **Enhance** and **WebC** are HTML-first tools from the Begin and Eleventy communities.

It is meant to be fair in both directions. Every number below was measured by [`compared/html-first/measure.mjs`](compared/html-first/measure.mjs), with the versions pinned in its `package.json`. [`html-first.test.js`](compared/html-first/html-first.test.js) checks that every component measured works in Chromium, and that the claims about what each server evaluates are still true.

## The first thing to say: rendering without Node.js isn't unique

Zubra's README leans on server rendering that needs no JavaScript server. Others do that too:

- **WebUI** renders templates in native Rust, from Node.js, Bun, Rust, .NET, Python, C, or WebAssembly. FAST 3's declarative templates render through it.
- **Enhance** has compiled its server renderer to WebAssembly since 2024: an Extism plugin, about 4.1 MB, that bundles the QuickJS engine. It renders from Python, Ruby, PHP, Go, Rust, Java and .NET.

What Zubra does that they don't is narrower:

- **One compiler for both halves.** The same compiler writes the server HTML and the browser element, from one `.zb` file, in Rust, with no JavaScript engine in it.
- **JavaScript expressions evaluated by Rust.** `{count + 1}`, `{done ? "yes" : "no"}` and method calls on known values render on the server, checked against V8 (`compiler/test/server-evaluation.test.js`). WebUI's templates take paths and comparisons only. Enhance and WebC evaluate any JavaScript, but they need a JavaScript engine to do it, Node.js or QuickJS.
- **Framework wrappers.** The same component is used from React, Vue, Svelte, Solid, Angular and Lit, typed (`docs/framework-matrix.md`).
- **`--emit element`.** A component as one plain file with no runtime to install.

## At a glance

| | Zubra | WebUI | FAST Element 3 | Enhance | WebC |
|---|---|---|---|---|---|
| You write | `.zb`: HTML, a `<script>`, a `<style>` | An HTML template, its CSS, and a class only for interactivity | A class with an `html` template, or a declarative `<f-template>` | A function returning HTML, and a browser class if it reacts | A `.webc` file: HTML, CSS and a `<script>` |
| Server rendering | The compiler, in Rust or WebAssembly | Native Rust, from several languages | Through WebUI, for declarative templates | JavaScript, or QuickJS in WebAssembly | JavaScript, at build time |
| Server templates evaluate | JavaScript expressions (a deterministic subset, reported by `zubra check --server`) | Paths, comparisons and `&&`/`||`; no arithmetic or ternaries | (WebUI's rules) | Any JavaScript | Any JavaScript |
| Browser behaviour | Compiled fine-grained bindings on a shared runtime, or one plain file | A framework runtime with decorators | A framework runtime with decorators | Your own code on a small base class | Your own code, no runtime |
| Used from frameworks | Generated wrappers for nine, typed | As custom elements | As custom elements | As custom elements | As custom elements |
| Beyond components | Server actions and synced state, as separate packages | Routing, streaming, lazy regions, desktop apps | Dependency injection, context | Routing, API routes, a full app framework | Eleventy's whole site generator |

## Measured

The README's copy button, written in each tool's own documented style ([`compared/html-first/components/`](compared/html-first/components)). Node.js 22 on Linux x64, measured 2026-11-13 with Zubra 5.13.0.

What the browser is sent. JavaScript is bundled and minified with esbuild, then compressed with gzip level 9. "Each more component" is a component's own code with its runtime left out, so ten components are the first with its runtime plus nine more. The page is ten copy buttons, as each server renders it.

| | JS, one component | Each more component | JS, ten components | HTML, page of ten buttons |
|---|---|---|---|---|
| Zubra `--emit element` (5.13.0) | 1.6 KB | 1.6 KB | 15.6 KB | 0.3 KB |
| Zubra `--emit js` + `@zubra/runtime` (production) | 14.2 KB | 0.5 KB | 19.0 KB | 0.3 KB |
| WebUI (3.1.1) | 30.2 KB | 0.4 KB | 33.9 KB | 0.8 KB |
| FAST Element (3.1.4) | 15.3 KB | 0.5 KB | 20.0 KB | 0.2 KB, rendered in the browser |
| Enhance (`@enhance/ssr` 4.0.3, `@enhance/custom-element` 1.2.4) | 2.1 KB | 0.5 KB | 6.6 KB | 0.3 KB |
| WebC (0.11.4) | 0.3 KB | 0.3 KB | 2.9 KB | 0.3 KB |

How long each server takes to render that page, in one Node.js process (3,000 renders after 300 to warm up). Absolute times depend on the machine; the ratios held across runs.

| Server | Render of the page of ten buttons | How it runs |
|---|---|---|
| WebUI (3.1.1) | 25 µs | A native Rust addon, in process. Templates are compiled to its protocol once, at build time |
| Enhance (`@enhance/ssr` 4.0.3) | 121 µs | JavaScript |
| Zubra (5.13.0) | 389 µs | The Rust compiler as WebAssembly, in process (`@zubra/compiler`). A parsed component is reused (since 5.9.0); each render still makes one request per component |
| WebC (0.11.4) | 917 µs | JavaScript. A build-time tool, so the whole page is compiled each time |

What the numbers say:

- **WebUI's server is about 15 times faster than Zubra's here.** WebUI compiles once and renders many times. Zubra's `@zubra/server` asks the compiler for each component on each request. Since 5.9.0 the compiler keeps what it parsed, but each request still costs about 30 µs in WebAssembly before any rendering (a request for just the component's CSS takes that long), and the server evaluator has grown since. That fixed cost per request is the next thing to fix (below).
- **For a few components, the smallest browser code is hand-written** (WebC, Enhance) or Zubra's `--emit element`. For many, a shared runtime wins: Zubra's `--emit js` passes `--emit element` at about ten components.
- **Zubra's shared runtime is less than half of WebUI's** and a little smaller than FAST's.

## WebUI: where it's better, and where Zubra differs

**Where WebUI is better:**

- **Server speed**, measured above, and the design behind it: templates compiled to a binary protocol at build time, rendered natively, with buffered and streaming output.
- **More of an application.** Routing, lazy regions that load on demand, deferred and interaction-triggered hydration, and desktop apps. Zubra brings no router (`docs/what-crosses-the-boundary.md`).
- **More server languages with native bindings:** Node.js and Bun, Rust, .NET, Python, and C for anything else. Zubra has Python, Ruby and PHP clients of a long-lived compiler process, and the Rust crate.
- **Microsoft behind it.**

**Where Zubra differs:**

- **Expressions in templates.** WebUI's text bindings are paths; its conditions take comparisons and `&&` or `||`, but not both in one condition, no parentheses, no ternaries and no arithmetic. What it can't evaluate renders as nothing, and the build gives no warning: `{{count + 1}}` is an empty paragraph. The server has to compute such values and send them as state. Zubra evaluates them, and `zubra check --server` lists what it can't.
- **Light DOM and scoped CSS by default.** WebUI's light-DOM CSS is global by design; Zubra scopes each component's `<style>` with `@scope`.
- **Framework wrappers, typings and a manifest, generated.**
- **A smaller browser runtime** (above), and `--emit element` for none.
- **No build step required to render.** `zubra compile` renders a `.zb` file directly; WebUI renders from a protocol built first.

## FAST 3: a neighbour

FAST Element is a library for writing components, and many design systems are built on it. Zubra components work inside FAST apps, and the reverse, with no adapter:

[`examples/frameworks/fast-orders`](../examples/frameworks/fast-orders) is an order sheet: a FASTElement in its own shadow root, with the registry's `quantity-stepper` and a `line-price` component inside it. Its browser test (`examples/frameworks/test/fast.test.js`, in the framework examples job) checks four things:

- FAST's `:value` and `:amount` bindings set the Zubra elements' properties.
- FAST's `@valuechange` binding hears the stepper.
- The Zubra elements' styles reach FAST's shadow root.
- The currency, provided by FAST's `Context`, is read by Zubra's `inject()` through the context protocol.

FAST's provider answers each request once, so a value it provides doesn't update its consumers later; Zubra's own `provide()` and `<zb-context>` do.

## Enhance: where it's better, and where Zubra differs

**Where Enhance is better:**

- **Small browser code** for a few components, and none at all for components that don't react.
- **A full application framework:** file-based routes, API routes, and forms that work without JavaScript, with the browser half written as plain platform code.
- **Every server value in the HTML,** first. Enhance gives each element an instance id and context from its ancestors during the server render. Zubra does the same since 5.9.0: `id()` gives each instance a base the browser keeps, and `provide()` / `inject()` reach nested components and the page during the server render.

**Where Zubra differs:**

- **Reactivity is compiled.** In Enhance, the browser half updates the DOM by hand after a change (the copy button sets `textContent` and toggles a class itself). Zubra compiles assignments into bindings.
- **No JavaScript engine to render.** Enhance on a non-JS server runs QuickJS inside WebAssembly; Zubra's compiler is native code.

## WebC: where it's better, and where Zubra differs

**Where WebC is better:**

- **No runtime at all,** and the smallest output here.
- **Eleventy around it,** for content sites.

**Where Zubra differs:**

- **WebC renders at build time.** It is fast enough for a site build, not for a request.
- **Its browser behaviour is hand-written,** with the bugs that hand-written elements have (the README's copy button lists two). Zubra compiles it.

## What this page changed in Zubra's plans

1. **Compile once, render many times on the server.** Done in 5.9.0 for parsing: a component is parsed once while its sources are unchanged. The fixed cost of each request (the JSON in and out of WebAssembly, the warnings pass, validating with the props) is what's left, and a page of ten components pays it ten times. Next: one request for a page's components, and a request that names files it already sent.
2. **Instance ids and context in server HTML,** as Enhance does. Done in 5.9.0.

When the first ships in full, the numbers and the sections above change with it.

## Choosing

- **WebUI** if server rendering speed matters most, and you want routing and streaming from the same framework, and your server languages are among its bindings.
- **FAST** if you're building a design system on a mature component library. Zubra components can live inside it.
- **Enhance** if you want a full HTML-first app framework with very little browser code.
- **WebC** if you're building an Eleventy site.
- **Zubra** if you want components written as HTML that compile to plain custom elements, render on any server from the same source, evaluate real expressions there, and plug into the frameworks your consumers use.
