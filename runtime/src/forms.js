// Form libraries: a Zubra control as a field of React Hook Form, TanStack Form, VeeValidate or
// Felte. Each helper turns what the library hands you for a field into the props (or the Svelte
// action) a Zubra control takes, through its two-way binding: a `<prop>` and its `<prop>change`
// event (`value` and `valuechange` by default).
//
//   React Hook Form   <Stepper {...registerProps(register('seats'))} />
//                     <Controller name="seats" render={({ field }) => <Stepper {...fieldProps(field)} />} />
//   TanStack Form     <form.Field name="seats">{(field) => <Stepper {...fieldProps(field)} />}</form.Field>
//   VeeValidate       <Stepper v-bind="vueFieldProps(useField('seats'))" />
//   Felte             <zb-stepper use:felteControl={createField('seats')}>
//
// Nothing here imports a library: each helper reads the shape the library documents. Native
// form submission needs none of this; a Zubra control with `form-associated` is already a form
// control (FormData, `<form method=post>`, server actions).

const handler = (prop) => `on${prop.toLowerCase()}change`; // the React wrapper takes any casing
const unref = (value) => (value && typeof value === 'object' && value.__v_isRef ? value.value : value);

/**
 * React Hook Form's `register(name)` as props for a wrapped Zubra control: the control's
 * `value`, its `valuechange` reported as a change, blur reported as a blur, and the element as
 * the ref (so `reset()` and `setValue()` write its `value`, and `setFocus()` focuses it). For a
 * control whose model isn't `value`, use `fieldProps` with a `<Controller>`.
 */
export function registerProps(registration) {
  const { name, ref, onChange, onBlur, disabled } = registration;
  return {
    name,
    ref,
    ...(disabled === undefined ? {} : { disabled }),
    onvaluechange: (event) => onChange({ type: 'change', target: { name, value: event.detail } }),
    onBlur: (event) => onBlur({ type: 'blur', target: { name, value: event.currentTarget?.value } }),
  };
}

/**
 * A field's props for a wrapped Zubra control in React, from React Hook Form's `<Controller>`
 * (`{ value, onChange, onBlur, name, ref }`) or TanStack Form's field API
 * (`{ state: { value }, handleChange, handleBlur, name }`). `prop` names the control's model
 * (`value` by default).
 */
export function fieldProps(field, { prop = 'value' } = {}) {
  const tanstack = typeof field.handleChange === 'function';
  const value = tanstack ? field.state.value : field.value;
  const change = tanstack ? field.handleChange : field.onChange;
  const blur = tanstack ? field.handleBlur : field.onBlur;
  return {
    name: field.name,
    [prop]: value,
    [handler(prop)]: (event) => change(event.detail),
    onBlur: () => blur(),
    ...(field.ref ? { ref: field.ref } : {}),
  };
}

/**
 * A field's props for a wrapped Zubra control in Vue, from VeeValidate's `useField()` (whose
 * `value` is a ref) or the `field` a `<Field v-slot="{ field }">` gives. `prop` names the
 * control's model (`value` by default).
 */
export function vueFieldProps(field, { prop = 'value' } = {}) {
  const change = field.handleChange ?? field.onChange;
  const blur = field.handleBlur ?? field.onBlur;
  const value = 'value' in field ? unref(field.value) : field.modelValue;
  return {
    name: unref(field.name),
    [prop]: value,
    [`onUpdate:${prop}`]: (next) => (Array.isArray(change) ? change.forEach((fn) => fn(next)) : change(next)),
    // The control's own focus leaves it: `blur` doesn't bubble out of its inner input, `focusout` does.
    onFocusout: (event) => (Array.isArray(blur) ? blur.forEach((fn) => fn(event)) : blur?.(event)),
  };
}

/**
 * Felte: a Svelte action (or a plain function for `@felte/vanilla`) that connects a Zubra control
 * to a field from Felte's `createField(name)`. Felte reads native inputs, so the field keeps a
 * hidden one in step with the control: each `<prop>change` is reported as input, focus leaving
 * the control as a blur, and Felte's own writes (`reset()`, `setFields()`) reach the control. Returns `{ destroy }`.
 *
 *   <zb-stepper use:felteControl={createField('seats')}></zb-stepper>
 */
export function felteControl(node, created, { prop = 'value' } = {}) {
  const field = created?.field ? created : null;
  if (!field) throw new TypeError("zubra: felteControl() needs the result of Felte's createField(name)");
  const action = field.field(node) ?? {};
  // Felte puts its hidden input in place, after the control, on the next task. Start it at the
  // control's value; keep a number a number (Felte reads `type="number"` inputs as numbers, and this
  // one stays hidden); and pass Felte's own writes to it (`reset()`, `setFields()`) to the control.
  let writing = false;
  const start = setTimeout(() => {
    const input = node.nextElementSibling;
    if (input?.localName === 'input' && input.type === 'hidden') {
      if (typeof node[prop] === 'number') {
        input.type = 'number';
        input.hidden = true;
      }
      const own = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      Object.defineProperty(input, 'value', {
        configurable: true,
        get: () => own.get.call(input),
        set: (value) => {
          own.set.call(input, value);
          if (!writing) node[prop] = input.type === 'number' && value !== '' ? Number(value) : value;
        },
      });
    }
    report(node[prop]);
  });
  const report = (value) => {
    writing = true;
    try { field.onInput(value); } finally { writing = false; }
  };
  const change = (event) => report(event.detail);
  const blur = () => field.onBlur();
  node.addEventListener(prop.toLowerCase() + 'change', change);
  node.addEventListener('focusout', blur);
  return {
    destroy() {
      clearTimeout(start);
      node.removeEventListener(prop.toLowerCase() + 'change', change);
      node.removeEventListener('focusout', blur);
      action.destroy?.();
    },
  };
}
