# The Zubra guide

Zubra compiles components written as HTML with a script and styles into standard web components: elements that work in plain HTML, in every major framework, and on the server.

**Try it first:** the [playground](https://journey-to-code-org.github.io/zubra/playground/) compiles in your browser and runs your component in plain HTML, React and Vue side by side.

**Start an app:**

```sh
npm create zubra@latest my-app
```

It asks for a framework (none, React, Vue, Svelte, Solid, Preact, Lit, Angular or Astro) and writes a working app with one component, a dev server that updates components in place, and a browser test.

## The tutorial

Each step builds on the last, in about ten minutes each.

1. [Your first component](01-first-component.md): props, state, events, and the dev loop.
2. [Templates](02-templates.md): conditions, lists, classes and styles, event modifiers, references.
3. [Two-way props and events](03-props-and-events.md): what frameworks bind to, and why you rarely fire events by hand.
4. [Composition and slots](04-composition.md): components using components, and content passed in.
5. [Forms](05-forms.md): elements that are real form controls.
6. [Async data](06-async-data.md): loading, errors and refetching, without effects.
7. [Server rendering](07-server-rendering.md): HTML first, hydrated in place.
8. [Read the output](08-read-the-output.md): what Zubra compiles to, and the platform rule behind each part.
9. [Forms that post to the server](09-server-actions.md): `'use server'` functions, with or without JavaScript (`@zubra/actions`).
10. [State that lives on the device](10-local-state.md): `'use collection'`, stored in the browser and shared when you want (`@zubra/sync`).

## Coming from a framework

- [Zubra for React developers](for-react-developers.md)
- [Zubra for Vue developers](for-vue-developers.md)
- [Zubra for Svelte developers](for-svelte-developers.md)

## Topics

- [Who Zubra is for](../who-this-is-for.md): where a compiled web component earns its place, and where your framework is the right tool.
- [What crosses the boundary](../what-crosses-the-boundary.md): props, events, slots and forms do; render props, framework context and Suspense don't.
- [Server rendering, honestly](../server-rendering.md): what renders where, without JavaScript, and the gaps that remain.
- [Compared with Lit and Stencil](../compared-with-lit-and-stencil.md): where each is the better choice, with measured sizes.
- [TypeScript in `.zb` files](../typescript.md): what the compiler does with types, what it refuses and why, and what reaches the typings.
- [Zubra on other people's pages](other-peoples-pages.md): embeds, extension content scripts, host isolation, tag names, and tables.
- [Accessible widgets without a headless library](accessible-widgets.md): what Radix and shadcn/ui give React, from the platform, `@zubra/runtime/primitives` and Zag.js.
- [Zubra with Tailwind, shadcn/ui, MUI and Bootstrap](styling-libraries.md): how components get the app's styles, light DOM and shadow DOM, with an example app for each.

## Reference

The [README](../../README.md) is the reference: every feature, option and rule. `docs/` has the rest (security, browser support).
