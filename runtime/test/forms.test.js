// The form-library helpers' shapes (src/forms.js); the browser suite runs them with the libraries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { registerProps, fieldProps, vueFieldProps, felteControl } from '../src/forms.js';

test('registerProps: React Hook Form\'s registration as a control\'s props', () => {
  const calls = [];
  const registration = { name: 'seats', ref: () => {}, onChange: (e) => calls.push(e), onBlur: (e) => calls.push(e) };
  const props = registerProps(registration);
  assert.deepEqual(Object.keys(props).sort(), ['name', 'onBlur', 'onvaluechange', 'ref']);
  props.onvaluechange({ detail: 4 });
  props.onBlur({ currentTarget: { value: 4 } });
  assert.deepEqual(calls, [
    { type: 'change', target: { name: 'seats', value: 4 } },
    { type: 'blur', target: { name: 'seats', value: 4 } },
  ]);
  assert.equal(registerProps({ ...registration, disabled: true }).disabled, true, 'disabled passes through when given');
});

test('fieldProps: a Controller field and a TanStack field, with another model prop', () => {
  const log = [];
  const controller = fieldProps({ name: 'a', value: 1, onChange: (v) => log.push(['c', v]), onBlur: () => log.push(['cb']), ref: 'r' });
  assert.equal(controller.value, 1);
  assert.equal(controller.ref, 'r');
  controller.onvaluechange({ detail: 2 });
  controller.onBlur();
  const tanstack = fieldProps({ name: 'b', state: { value: 'x' }, handleChange: (v) => log.push(['t', v]), handleBlur: () => log.push(['tb']) }, { prop: 'selectedIndex' });
  assert.equal(tanstack.selectedIndex, 'x');
  assert.equal('ref' in tanstack, false);
  tanstack.onselectedindexchange({ detail: 'y' });
  tanstack.onBlur();
  assert.deepEqual(log, [['c', 2], ['cb'], ['t', 'y'], ['tb']]);
});

test('vueFieldProps: useField (refs) and a <Field> slot field (listener arrays)', () => {
  const log = [];
  const used = vueFieldProps({ name: ref('seats'), value: ref(3), handleChange: (v) => log.push(v), handleBlur: () => log.push('blur') });
  assert.equal(used.name, 'seats');
  assert.equal(used.value, 3);
  used['onUpdate:value'](4);
  used.onFocusout({});
  const slot = vueFieldProps({ name: 'open', value: true, onChange: [(v) => log.push(`a${v}`), (v) => log.push(`b${v}`)], onBlur: [() => log.push('x')] }, { prop: 'open' });
  assert.equal(slot.open, true);
  slot['onUpdate:open'](false);
  slot.onFocusout({});
  assert.deepEqual(log, [4, 'blur', 'afalse', 'bfalse', 'x']);
});

test('felteControl needs a Felte field', () => {
  assert.throws(() => felteControl({}, {}), /createField/);
});
