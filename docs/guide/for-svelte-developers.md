# Zubra for Svelte developers

Svelte and Zubra make the same bet: compile components ahead of time, update only what changed, and keep the authoring format close to HTML. Svelte 5's runes map almost one to one.

| Svelte 5 | Zubra |
|---|---|
| `let { label = "Hi" } = $props()` | `<my-greeting label="Hi">`: the host tag's attributes are the props |
| `let count = $state(0)` | `let count = 0` |
| `const doubled = $derived(count * 2)` | `const doubled = count * 2` |
| `let left = $derived(seconds)`, then `left--` (a writable derived) | `let left = from(seconds)`, then `left--` |
| `$effect(() => …)` | `effect(() => …)` |
| `let { value = $bindable(0) } = $props()` | `value:model={0}` on the host |
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

Import the `.zb` file and use the tag. Svelte sets props as properties and listens with `on<name>`:

```svelte
<script>
  import './components/quantity-stepper.zb';
  let tickets = $state(1);
</script>

<quantity-stepper value={tickets} onvaluechange={(event) => (tickets = event.detail)} max={4}></quantity-stepper>
```
