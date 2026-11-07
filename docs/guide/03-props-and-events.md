# 3. Two-way props and events

Components talk to the outside the way built-in elements do: **properties in, DOM events out**. That's why one component works in every framework without glue code.

## Events

```html
<script>
  import { emit } from '@mnx/runtime'

  function pick(color) {
    emit('colorpick', color)
  }
</script>
<color-picker colors={["red", "green", "blue"]}>
  <mnx-each items={colors} as="color" key={color}>
    <button type="button" style:background={color} aria-label={color} onclick={() => pick(color)}></button>
  </mnx-each>
</color-picker>
```

- `emit(name, detail)` fires a `CustomEvent` from the element. It bubbles, and `detail` carries the value.
- Calling `emit` declares the event: it appears in the typings (`colorpick: CustomEvent<string>`) and the docs. There's nothing to register.
- Names are lowercase, like the platform's own (`colorpick`, not `colorPick`): every framework can listen to those declaratively. A camelCase name is an error that suggests the right one.
- `before…` events are cancelable: `if (!emit('beforeclose')) return` stops when a listener called `preventDefault()`.

Listening, in each place the element is used:

| Where | |
|---|---|
| Plain HTML | `el.addEventListener('colorpick', (event) => …)` |
| Another mnx component | `<color-picker oncolorpick={(event) => …}>` |
| React (through the plugin) | `<ColorPicker onColorPick={(event) => …} />` |
| Vue | `<ColorPicker @colorpick="…" />` |
| Svelte, Preact | `oncolorpick={(event) => …}` |
| Solid | `on:colorpick={(event) => …}` |
| Lit | `@colorpick=${(event) => …}` |
| Angular | `(colorpick)="…"` |

## Two-way props

Most interactive components have a value the user changes: a toggle's `checked`, a stepper's `value`. Mark that prop with `:model`:

```html
<toggle-switch checked:model={false} label="Notifications">
  <button type="button" role="switch" aria-checked={checked ? "true" : "false"} onclick={() => (checked = !checked)}>
    {label}
  </button>
</toggle-switch>
```

Now, whenever the component assigns `checked`, the element fires `checkedchange` with the new value. Nothing fires when the value is set from outside, because the caller already knows it. Frameworks bind to exactly that pair:

| | |
|---|---|
| Vue | `<ToggleSwitch v-model:checked="enabled" />` (and `v-model` for a `value` prop) |
| React | `<ToggleSwitch checked={enabled} onCheckedChange={(event) => setEnabled(event.detail)} />` |
| Svelte | `<toggle-switch checked={enabled} oncheckedchange={(event) => (enabled = event.detail)}>` |
| Angular | `<toggle-switch mnxModel="checked" [(ngModel)]="enabled">` with `MnxModel` |

## Typing props

A prop's type comes from its default: `count={0}` is a `number`, `label="Hi"` a `string`. When the default doesn't say enough (`null`, `[]`), declare the type in a TypeScript script:

```html
<script lang="ts">
  type Size = 'small' | 'medium' | 'large'
  declare const size: Size
  declare const value: number | null
</script>
<number-field size="medium" value:model={null}>…</number-field>
```

The declaration only types the prop (the default still comes from the host tag), and the typings, the manifest and other components' checks all use it.

## Signals that read like values

For state shared between components, or anything outside one element, `state()` and `computed()` from `@mnx/runtime` make explicit signals. A `const` holding one reads like a value in the template:

```html
<script>
  import { inject } from '@mnx/runtime'
  import { session } from '../session.js'

  const user = inject(session)                 // a signal that follows the nearest provider
  const greeting = `Hi, ${user.get()?.name}`   // derived: stays in sync
</script>
<user-badge>
  <span>{greeting}</span> <small>{user.email}</small>
</user-badge>
```

In the script, call `.get()` and `.set()`. In the template, `{user.email}` means `user.get().email`.

**Next:** [Composition and slots](04-composition.md)
