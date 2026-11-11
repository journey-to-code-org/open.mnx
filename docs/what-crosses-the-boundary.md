# What crosses the boundary

A Zubra component is a custom element, and a custom element is a boundary in the DOM. The framework on the outside sees an element; the component on the inside sees props, events and children. Some things cross that boundary cleanly, and some don't, and the most common disappointment with web components is finding out which after the component is written.

This page is the rule of thumb and the list.

## The rule of thumb

**If the component would be a leaf in the consumer's tree, it fits. If it would be a layout or a container of the consumer's own components, write it in the consumer's framework.**

A leaf takes data in and sends events out: a date picker, a chart, a rating, a tag input, a video player, a card. It can hold children (slots), but it doesn't need to know what they are. A container composes the app's own components, reads the app's context and takes part in the app's lifecycle: a page layout, a route, a data table whose cells are the app's components, a form that validates against the app's store. Through an adapter, a container fights the framework at every turn, and nobody enjoys using it. Every component in `registry/` is a leaf; that's not an accident.

## What crosses

| Through the boundary | How | In the frameworks |
|---|---|---|
| **Props**, including objects, arrays and functions | Set as properties on the element; attributes are a typed fallback (JSON for arrays and objects) | The generated React and Vue wrappers set properties; React 19, Svelte, Solid, Angular and Lit set properties on their own; typings check them |
| **Events** | `CustomEvent` from the host, data in `detail`, bubbling (and `composed` in shadow DOM), lowercase names like the DOM's own | React `onValueChange`, Vue `@valuechange`, Angular `(valuechange)`, Svelte `onvaluechange`, Solid `on:valuechange`, all from the one DOM event |
| **Two-way binding** | A `:model` prop and its `<prop>change` event | Vue `v-model`, Svelte with the prop and `on<prop>change` (Svelte 5 refuses `bind:` on a custom element), Angular forms (`ngModel`, `formControlName`) via the `ZubraModel` directive, React's controlled pattern, Zubra `value:bind` |
| **Children and named slots** | Light-DOM children placed into `zb-slot` regions (native `<slot>` with `shadow`); the framework keeps managing them through the host | React and Vue children, Svelte and Solid children, plain HTML; content stays the consumer's, styled and updated by the consumer |
| **Form participation** | `form-associated`: the element is a form control with a name, a value, validation and reset | Works with every server form API tried: Next.js Server Actions, SvelteKit actions, React Router `<Form>`, SolidStart actions, htmx |
| **Context, between custom elements** | The Context Protocol (`context-request` event) | Shared with Lit (`@lit/context`) and any other implementer, in any framework's page |
| **Refs to the host** | The element is a real DOM node | `ref`, `bind:this`, `@ViewChild`, template refs |
| **Server rendering** | The compiler emits the HTML; the element hydrates it in place | Plain servers, Astro, and the SSR bridge for Nuxt, SvelteKit, React Router, SolidStart and Next.js (see [Server rendering, honestly](server-rendering.md)) |
| **Styling from outside** | Light DOM: page CSS applies, and the component's own styles are scoped with `@scope`. Shadow DOM: custom properties, `::part`, and `adoptStyles()` for app-wide CSS | Tailwind, design tokens, a global stylesheet |

## What doesn't cross

| Doesn't cross | Why | What to do instead |
|---|---|---|
| **Render props** (a function prop that returns the consumer's markup) | The element can't render React or Vue nodes; it only knows the DOM | Slots: let the consumer put real elements inside. If the markup depends on data the component owns, render it in the component and expose the data by event |
| **Framework context** (React `useContext`, Vue `provide/inject`, Svelte `setContext`) | Those are the framework's own trees, invisible from inside the element | Pass it as a prop. Between Zubra components, use the Context Protocol |
| **Framework lifecycle** (Suspense, transitions, error boundaries, `useTransition`, Vue's `<KeepAlive>`) | The element has the DOM's lifecycle: connected, disconnected, attributes changed. It can't suspend the consumer's tree or be kept alive by it | Make loading a prop or an event; `resource()` and `<zb-await>` handle it inside the component |
| **Framework hooks inside the component** | `useState` needs React's renderer; the component runs once and binds | The Zubra hooks (`state`, `computed`, `effect`, `onMount`, `inject`) and plain functions built on them |
| **The consumer's components as the component's children by name** (`<Table rowComponent={Row}>`) | The element can't instantiate a framework component | Slots, or a component written in the framework |
| **Deep styling of the component's internals from the consumer**, in shadow DOM | That's the encapsulation shadow DOM provides | Light DOM (the default) if the consumer should style it, or `::part` and custom properties for what the component chooses to expose |

## Two cases that look like they cross and don't quite

- **Refs to elements inside the component.** The consumer gets the host. What's inside is the component's. Expose methods on the host (`focus()`, `reset()`) rather than letting the consumer reach in.
- **A list whose rows are the consumer's components.** A table component can take the data and render the rows itself, or take rows as slotted children, but it can't take a row component from the consumer and render it per item. If each row is the app's own component, the table is a container: write it in the framework and put Zubra components in the cells.

## When you're not sure

Ask what the component would need to know about the app. Nothing but the data it's given and the events it fires: it's a leaf, and Zubra is the right tool. The app's store, router, context or component types: it's a container, and the right tool is the framework. The leaf components you write with Zubra will work inside the container either way.
