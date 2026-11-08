# Who mnx is for

mnx is a compiler, and a compiler is only worth adding to a project when it removes more than it costs. This page says where it does, and where it doesn't, so you can decide in a minute. It comes from asking developers who don't use web components why not (`plan/evidence/` in the project docs records the conversation).

## The short version

A web component is the browser's own component boundary. mnx lets you write one as HTML with `{bindings}` instead of a class, and compiles it to the element, its server HTML, its types and a React or Vue wrapper. **The win is one component with more than one consumer.** If every consumer of your component is the same app on the same framework, you don't need it.

## It's for you if

- **You write a component library or a design system** that teams on more than one framework use, or might. One source, one review, one test suite; each framework gets a generated wrapper and typings rather than a port. This is where every web-component effort that has lasted (Shoelace, Ionic, Spectrum, Lit's users) actually lives.
- **You hand components to other people's stacks**: an agency delivering to clients on different frameworks, a platform team serving product teams that chose their own, a vendor whose widget is embedded in customers' apps.
- **Your component has to live somewhere a framework doesn't**: a CMS theme, an older server-rendered app, a static site, a marketing page, an extension, someone else's page.
- **You've been through a framework migration**, and want the next one to leave the components alone.
- **You want server-rendered HTML without a JavaScript server.** The compiler renders components from Rust, so Flask, Rails, Go or a static-site generator can send real markup and the element hydrates it in place.

## It's not for you if

- **You have one app on one framework and no one else uses its components.** Write them in your framework. A React team with no shared consumers is right to duplicate rather than add a compiler, and nothing in mnx would make its components better than the ones it already has.
- **The component is really a piece of your app's state.** A layout, a route, a container that composes the app's own components and reads its context: that belongs in the framework. [What crosses the boundary](what-crosses-the-boundary.md) says where the line is.
- **You mix frameworks on a page and that's all you need.** Astro lets a React island and a Svelte island coexist on one page. mnx lets one component be used by both. If coexisting is enough, Astro is simpler.
- **It's one button on one page.** `<button id="copy">` and a `<script>` is the right amount of code. mnx starts to earn its place at the second copy, when the same thing has to live on three pages with different text.

## What the honest objections are

People who have tried web components and stopped usually give one of these. Each is a real cost, and here is where mnx stands on it:

| Objection | Where it stands |
|---|---|
| "Shadow DOM is great in theory, not in practice." | Agreed. mnx renders into light DOM by default; shadow DOM is a flag on the host. Styles are scoped without it (`@scope`), page CSS reaches in, and native inputs inside the element submit with forms. |
| "SSR needs heavy emulation." | The compiler renders the HTML itself, in Rust or WebAssembly, with no DOM emulation. The element then hydrates that HTML. [Server rendering, honestly](server-rendering.md) says exactly what renders where, and where it still falls short inside meta-frameworks. |
| "You need an adapter for each framework, which defeats the purpose." | You need one, and you don't write it. The React and Vue wrappers, the Angular directive and the Svelte and Solid typings are generated from the component's own interface. The purpose is that the element is the standard thing and the adapter is the on-ramp for teams that can't switch today. |
| "Agents make rewriting a component for another framework cheap." | They do. What they don't make cheap is reviewing four copies, keeping them matching after one team tweaks theirs, and remembering to apply every fix everywhere. One source is one review. The claim is about scale: at three components, ports win; at a design system, the generator does. |
| "Every library is React-first." | True, and the reason `mnx convert` exists: it turns React function components into mnx components, and reports what it couldn't convert instead of guessing. |

## The one-line pitch, if you need one

Write a component once, as HTML. Use it from React, Vue, Svelte, Angular, Solid, plain HTML and the server, with no integration code. The runtime is built from the primitives the platform is standardizing, so it gets smaller as browsers ship them.
