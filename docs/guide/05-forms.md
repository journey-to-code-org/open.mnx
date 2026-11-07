# 5. Forms

`form-associated` on the host makes the element a real form control: it submits a value under its `name`, takes part in validation, resets with the form, and is disabled by a disabled `<fieldset>`.

```html
<!-- quantity-stepper.mnx -->
<script>
  import { validity } from '@mnx/runtime'

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

In frameworks it's an ordinary control too: Vue's `v-model`, React's controlled pattern (`value` + `onValueChange`), and in Angular, `MnxModel` with `ngModel` or `formControlName`.

**Next:** [Async data](06-async-data.md)
