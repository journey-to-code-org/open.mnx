# 5. Forms

`form-associated` on the host makes the element a real form control: it submits a value under its `name`, takes part in validation, resets with the form, and is disabled by a disabled `<fieldset>`.

```html
<!-- quantity-stepper.zb -->
<script>
  import { validity } from '@zubra/runtime'

  validity(() => (value > max ? `At most ${max}` : ""))
</script>
<quantity-stepper form-associated value:model={1} min={0} max={10}>
  <button type="button" disabled={value <= min} onclick={() => value--}>−</button>
  <output>{value}</output>
  <button type="button" disabled={value >= max} onclick={() => value++}>+</button>
</quantity-stepper>
```

```html
<form>
  <label>Tickets <quantity-stepper name="tickets" max="4"></quantity-stepper></label>
  <button>Book</button>
  <button type="reset">Start over</button>
</form>
```

- With one `:model` prop, that prop **is the form value**: the form submits `tickets=1`, and a reset puts it back to its initial value. `null`, `false` and `""` submit nothing; `true` submits `"on"`; objects are submitted as JSON.
- `formValue(() => …)` submits something else instead (say, a date range as `"2026-01-02/2026-01-05"`).
- `validity(() => message)` blocks submission while it returns a message, and sets `:invalid`. `""` means valid.
- The element has the native control API: `form`, `labels`, `validity`, `checkValidity()`, `reportValidity()`. `<label>` works with it like with an `<input>`.

## Forms that work before JavaScript

On a server-rendered page, the same form should work with JavaScript off and get better with it on. Zubra gives you the pieces:

```html
<script>
  import { hydrated } from '@zubra/runtime'
  const live = hydrated()
</script>
<ticket-filters status="">
  <form method="get">
    <select name="status" value={status} onchange.submit>
      <option value="">Any</option>
      <option value="open">Open</option>
    </select>
    <textarea name="note" onkeydown.mod.enter.prevent.submit></textarea>
    <zb-if test={!live}><button>Apply</button></zb-if>
  </form>
</ticket-filters>
```

- **`value` on a `<select>` or `<textarea>`** is right in the server's HTML: the matching `<option>` is `selected`, and the textarea holds the text.
- **`.submit`** submits the form after any handler, with validation. `onchange.submit` needs no handler at all.
- **`.mod`** is ⌘ on a Mac and Ctrl elsewhere, so `onkeydown.mod.enter` is the usual "send" shortcut.
- **`hydrated()`** is `false` in the server's HTML and `true` once the element has started. Here the Apply button exists only until then. The host also gets `:state(hydrated)` for CSS.

Native controls (inputs, selects, checkboxes) in light DOM submit before any JavaScript. A form-associated element submits only once it has started, so keep a native control inside it when the page must work without JavaScript. (In a meta-framework, `@zubra/server`'s `injectShadowRoots` covers this: it gives a form-associated element with a `name` a hidden input holding its server-rendered value.) `zubra check --server` tells you where the server's HTML would leave a control's state out.

In frameworks it's an ordinary control too: Vue's `v-model`, React's controlled pattern (`value` + `onValueChange`), and in Angular, `ZubraModel` with `ngModel` or `formControlName`.

**Next:** [Async data](06-async-data.md)
