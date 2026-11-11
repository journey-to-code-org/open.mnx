# Zubra for Svelte developers

Svelte and Zubra make the same bet: compile components ahead of time, update only what changed, and keep the authoring format close to HTML. Svelte 5's runes map almost one to one.

| Svelte 5 | Zubra |
|---|---|
| `let { label = "Hi" } = $props()` | `<my-greeting label="Hi">`: the host tag's attributes are the props |
| `let count = $state(0)` | `let count = 0` |
| `const doubled = $derived(count * 2)` | `const doubled = count * 2` |
| `let left = $derived(seconds)`, then `left--` (a writable derived) | `let left = from(seconds)`, then `left--` |
| `$effect(() => …)` | `effect(() => …)` |
| `let { value = $bindable(0) } = $props()` | `value:model={0}` on the host (bound from a Svelte app with the prop and its `on<name>change` event, see below) |
| `{#if a}…{:else if b}…{:else}…{/if}` | `<zb-if test={a}>…<zb-else-if test={b}>…</zb-else-if><zb-else>…</zb-else></zb-if>` |
| `{#each items as item (item.id)}` | `<zb-each items={items} as="item" key={item.id}>` |
| `{#await promise}…{:then v}…{:catch e}…{/await}` | `<zb-await value={promise}>…<zb-then as="v">…</zb-then><zb-catch as="e">…</zb-catch></zb-await>` |
| `class:active={isActive}` | `class:active={isActive}` |
| `style:color={color}` | `style:color={color}` |
| `bind:this={input}` | `ref={input}` |
| `<svelte:window onkeydown={…}>` | `<zb-window onkeydown={…}>` |
| `onclick={handler}` | `onclick={handler}`, with modifiers: `onsubmit.prevent={save}` |
| `{@render children()}`, snippets | `<zb-slot>`, named slots |
| `createEventDispatcher` / callback props | `emit('select', id)` |
| `<style>` (scoped) | `<style>` (scoped) |

The difference is the output: a standard custom element, not a Svelte component, so it also runs in React, Vue, Angular and plain HTML, and renders on the server without Svelte.

## Using Zubra components in a Svelte app

Import the `.zb` file for its side effect, which defines the element, and use the tag. These are lines of the [flashcards trainer](../../examples/frameworks/svelte-flashcards):

<!-- snippet: examples/frameworks/svelte-flashcards/src/App.svelte#svelte-imports -->
```svelte
import './components/flip-card.zb';
import './components/grade-buttons.zb';
import './components/progress-ring.zb';
```

Svelte sets props as properties (objects and arrays arrive as values) and listens with `on<name>`, which is the element's lowercase DOM event. `detail` is the payload, and named slots are `slot="…"` on the children. A two-way prop is written as the prop and its `<name>change` event, as `flipped` is here: Svelte 5 refuses `bind:` on a custom element (`bind:value` is a compile error on anything but a form control), so there is no shorter spelling:

<!-- snippet: examples/frameworks/svelte-flashcards/src/App.svelte#svelte-flip -->
```svelte
<flip-card {flipped} onflippedchange={(event) => (flipped = event.detail)}>
  <div slot="front" class="side"><small>Question</small><p class="front-text">{current.front}</p></div>
  <div slot="back" class="side"><small>Answer</small><p class="back-text">{current.back}</p></div>
</flip-card>
```

<!-- snippet: examples/frameworks/svelte-flashcards/src/App.svelte#svelte-grade -->
```svelte
<grade-buttons disabled={!flipped} ongrade={(event) => grade(event.detail)}></grade-buttons>
```

## What you get with Svelte

Each line links the test that checks it. The tests run on every push.

- A whole app on Zubra elements: flipping a card with a click or Space (the card is focusable), the back face as a named slot, grading by button or by key, a progress ring and box counts that follow the state, and progress saved across reloads ([`svelte.test.js`](../../examples/frameworks/test/svelte.test.js)).
- Real server rendering. Under SvelteKit, the stats, the list and the form of the workout log are in the server HTML with JavaScript off, and logging a workout works through the form action ([`sveltekit-workouts`](../../examples/meta/sveltekit-workouts/test/app.test.js)).
- Form controls submit like native inputs through SvelteKit's actions, enhanced, and the action validates on the server ([`sveltekit-workouts`](../../examples/meta/sveltekit-workouts/test/app.test.js)).
- In the ports experiment Svelte's ports differed from the source in 20 places, against 6 for Vue. It was one agent and one run with one-shot ports, so this is a measurement, not a ranking ([the experiment](../standards/one-source-n-consumers.md)).
- The same `.zb` file also runs in React, Vue, Angular, Solid, Lit, Preact, Astro and plain HTML apps, each row checked in CI ([the framework matrix](../framework-matrix.md)).

## What doesn't cross

The general rules, with the reasons, are in [What crosses the boundary](../what-crosses-the-boundary.md): props, events, slots and forms cross; snippets passed as props, `setContext`/`getContext` and Svelte's own lifecycle don't. For Svelte in particular:

- **`bind:` doesn't work on the element.** Svelte 5 allows `bind:value` only on `<input>`, `<textarea>` and `<select>`, and a component binding only on Svelte components. Pass the prop and listen for `on<name>change`; `bind:this` does work, since the element is a DOM node.
- **Snippets can't be passed in.** `{#snippet}` and `{@render}` are Svelte's; the element takes slotted children instead.

- **`setContext` / `getContext` don't reach into the element.** Pass the value as a prop; between Zubra components use `createContext`.
- **Under SvelteKit every Zubra element is `shadow`.** Svelte claims every node it hydrates, so light-DOM content can't be server-rendered there. `@zubra/server` fills the declarative shadow roots before hydration; the plugin adds `zb-props` in the server build ([Server rendering, honestly](../server-rendering.md)).
- **Svelte renders the host tag only on the server.** What is inside the element comes from Zubra, not from Svelte's markup.

**Which framework do you use alongside Zubra, and what would a page written for you need to show?** [Tell us in an issue](https://github.com/journey-to-code-org/zubra/issues/new).
