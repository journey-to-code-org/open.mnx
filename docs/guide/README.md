# The mnx guide

mnx compiles components written as HTML with a script and styles into standard web components: elements that work in plain HTML, in every major framework, and on the server.

**Try it first:** the [playground](https://journey-to-code-org.github.io/open.mnx/) compiles in your browser and runs your component in plain HTML, React and Vue side by side.

**Start an app:**

```sh
npm create mnx@latest my-app
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

## Coming from a framework

- [mnx for React developers](for-react-developers.md)
- [mnx for Vue developers](for-vue-developers.md)
- [mnx for Svelte developers](for-svelte-developers.md)

## Topics

- [mnx on other people's pages](other-peoples-pages.md): embeds, extension content scripts, host isolation, tag names, and tables.

## Reference

The [README](../../README.md) is the reference: every feature, option and rule. `docs/` has the rest (security, browser support, migrations).
