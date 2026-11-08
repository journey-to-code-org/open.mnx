# 1. Your first component

An `.zb` file is one component: a script, styles, and a template whose root is the element itself.

```html
<!-- src/components/like-button.zb -->
<script>
  let pressed = 0
  const label = pressed === 0 ? "Like" : `Liked ×${pressed}`
</script>
<style>
  button { font: inherit; padding: 0.4rem 0.9rem; border-radius: 999px; }
</style>
<like-button emoji="👍">
  <button type="button" onclick={() => pressed++}>{emoji} {label}</button>
</like-button>
```

Read it top to bottom:

- **`let pressed = 0`** is **state**. Assigning it (`pressed++`, `pressed = 0`) updates whatever reads it. There's no `useState` and no `.set()`. Arrays and objects in state update when mutated, too: `items.push(x)` is enough.
- **`const label = …`** reads state, so it's **derived**: it stays in sync with `pressed`, like a computed value.
- **`<style>`** applies to this component only. The selectors are scoped to it, even in light DOM.
- **`<like-button emoji="👍">`** is the host tag. Its name is the custom element's name (it needs a hyphen), and its attributes are the **props**, with their defaults: `emoji` is a string prop that defaults to `"👍"`. `size={2}` would be a number prop, `items={[]}` an array.
- **`{label}`** inside it reads the derived value. Only the text node that shows it updates when it changes. Nothing re-renders, and the script runs once per element.

The button renders in **light DOM**: it's a real page element, your page's CSS reaches it, and inside a form it submits like any button. Shadow DOM is a flag (`<like-button shadow>`) for when you want the encapsulation, not the price of entry.

## Use it

In a page, import the module and write the tag:

```html
<like-button></like-button>
<like-button emoji="❤️"></like-button>
<script type="module">
  import './components/like-button.zb';
</script>
```

In React, Vue and other frameworks, importing the file gives you a component (React and Vue) or defines the element (everyone else). Typings are written next to the file, so props and events are checked and autocompleted. Each framework's page in the [README](../../README.md#using-components-in-an-app) has the details.

## The dev loop

In an app made by `npm create zubra`, run `npm run dev` and edit the component. It updates in place: elements on the page keep their state (`pressed` keeps its count) and the content given to them. A compile error shows in the browser with the line and a suggested fix. If you change the element's interface (add a prop or event), the page reloads instead.

From the command line, without a bundler:

```sh
zubra check src/components/like-button.zb              # errors and warnings, with suggestions
zubra compile src/components/like-button.zb --emit js  # the module the browser runs
zubra compile src/components/like-button.zb            # the HTML a server sends
```

## Props from the script's point of view

A prop's name is the prop, in the script as in the template. Read `emoji`, or assign `emoji = "🎉"`, and the element updates as if it were set from outside. That's why the script can't declare its own `emoji`.

A prop needs no attribute to be set: frameworks set it as a property, so objects and arrays arrive as values (`el.items = [...]`).

**Next:** [Templates](02-templates.md)
