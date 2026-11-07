# mnx for Svelte developers

Svelte and mnx make the same bet: compile components ahead of time, update only what changed, and keep the authoring format close to HTML. Svelte 5's runes map almost one to one.

| Svelte 5 | mnx |
|---|---|
| `let { label = "Hi" } = $props()` | `<my-greeting label="Hi">`: the host tag's attributes are the props |
| `let count = $state(0)` | `let count = 0` |
| `const doubled = $derived(count * 2)` | `const doubled = count * 2` |
| `let left = $derived(seconds)`, then `left--` (a writable derived) | `let left = from(seconds)`, then `left--` |
| `$effect(() => …)` | `effect(() => …)` |
| `let { value = $bindable(0) } = $props()` | `value:model={0}` on the host |
| `{#if a}…{:else if b}…{:else}…{/if}` | `<mnx-if test={a}>…<mnx-else-if test={b}>…</mnx-else-if><mnx-else>…</mnx-else></mnx-if>` |
| `{#each items as item (item.id)}` | `<mnx-each items={items} as="item" key={item.id}>` |
| `{#await promise}…{:then v}…{:catch e}…{/await}` | `<mnx-await value={promise}>…<mnx-then as="v">…</mnx-then><mnx-catch as="e">…</mnx-catch></mnx-await>` |
| `class:active={isActive}` | `class:active={isActive}` |
| `style:color={color}` | `style:color={color}` |
| `bind:this={input}` | `ref={input}` |
| `<svelte:window onkeydown={…}>` | `<mnx-window onkeydown={…}>` |
| `onclick={handler}` | `onclick={handler}`, with modifiers: `onsubmit.prevent={save}` |
| `{@render children()}`, snippets | `<mnx-slot>`, named slots |
| `createEventDispatcher` / callback props | `emit('select', id)` |
| `<style>` (scoped) | `<style>` (scoped) |

The difference is the output: a standard custom element, not a Svelte component, so it also runs in React, Vue, Angular and plain HTML, and renders on the server without Svelte.

## Using mnx components in a Svelte app

Import the `.mnx` file and use the tag. Svelte sets props as properties and listens with `on<name>`:

```svelte
<script>
  import './components/quantity-stepper.mnx';
  let tickets = $state(1);
</script>

<quantity-stepper value={tickets} onvaluechange={(event) => (tickets = event.detail)} max={4}></quantity-stepper>
```
