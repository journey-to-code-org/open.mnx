// Form libraries with a Zubra control (src/forms.js): React Hook Form (register and Controller),
// TanStack Form, VeeValidate and Felte each read the control's value as it changes, see it
// blurred, validate it, and write it back on reset. `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site } from './harness.js';

useBrowser({ 'model-input': join(here, 'fixtures/model-input.zb') });

const src = join(here, '../../src');

const RHF_APP = `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useForm, Controller } from 'react-hook-form';
import { wrap } from '${src}/react.js';
import { registerProps, fieldProps } from '${src}/forms.js';
import Element from '/model-input.js';
const Stepper = wrap(Element);
function App() {
  const { register, control, handleSubmit, reset, watch, formState } = useForm({
    defaultValues: { seats: 2, guests: 2 }, mode: 'onBlur',
  });
  window.form = { reset, values: () => watch() };
  const seats = watch('seats'), guests = watch('guests');
  return (
    <form onSubmit={handleSubmit((data) => { window.submitted = data; })}>
      <Stepper id="seats" {...registerProps(register('seats', { validate: (v) => v <= 3 || 'too many' }))} />
      <Controller name="guests" control={control} render={({ field }) => <Stepper id="guests" {...fieldProps(field)} />} />
      <p id="watched">{seats},{guests}</p>
      <p id="touched">{Object.keys(formState.touchedFields).sort().join(',')}</p>
      <p id="error">{formState.errors.seats?.message ?? ''}</p>
      <button id="submit">Save</button>
    </form>
  );
}
const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<App />));
`;

const TANSTACK_APP = `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useForm } from '@tanstack/react-form';
import { wrap } from '${src}/react.js';
import { fieldProps } from '${src}/forms.js';
import Element from '/model-input.js';
const Stepper = wrap(Element);
function App() {
  const form = useForm({ defaultValues: { seats: 2 }, onSubmit: ({ value }) => { window.submitted = value; } });
  window.form = { reset: () => form.reset() };
  return (
    <form onSubmit={(e) => { e.preventDefault(); form.handleSubmit(); }}>
      <form.Field name="seats" validators={{ onChange: ({ value }) => (value > 3 ? 'too many' : undefined) }}>
        {(field) => (
          <>
            <Stepper id="seats" {...fieldProps(field)} />
            <p id="watched">{field.state.value}</p>
            <p id="touched">{field.state.meta.isBlurred ? 'seats' : ''}</p>
            <p id="error">{field.state.meta.errors.join(',')}</p>
          </>
        )}
      </form.Field>
      <button id="submit">Save</button>
    </form>
  );
}
const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<App />));
`;

const VEE_APP = `
import { createApp, h } from 'vue';
import { useForm, useField } from 'vee-validate';
import { wrap } from '${src}/vue.js';
import { vueFieldProps } from '${src}/forms.js';
import Element from '/model-input.js';
const Stepper = wrap(Element);
const App = {
  setup() {
    const { handleSubmit, resetForm } = useForm({ initialValues: { seats: 2 } });
    const seats = useField('seats', (v) => v <= 3 || 'too many');
    const submit = handleSubmit((values) => { window.submitted = values; });
    window.form = { reset: () => resetForm() };
    return () => h('form', { onSubmit: submit }, [
      h(Stepper, { id: 'seats', ...vueFieldProps(seats) }),
      h('p', { id: 'watched' }, String(seats.value.value)),
      h('p', { id: 'touched' }, seats.meta.touched ? 'seats' : ''),
      h('p', { id: 'error' }, seats.errorMessage.value ?? ''),
      h('button', { id: 'submit' }, 'Save'),
    ]);
  },
};
createApp(App).mount('#root');
`;

const FELTE_APP = `
import { createForm, createField } from '@felte/vanilla';
import { felteControl } from '${src}/forms.js';
import '/model-input.js';
const root = document.getElementById('root');
root.innerHTML = '<form><zb-model-input id="seats"></zb-model-input><p id="watched"></p><p id="touched"></p><p id="error"></p><button id="submit">Save</button></form>';
const { form, data, touched, errors, reset } = createForm({
  initialValues: { seats: 2 },
  validate: (values) => (values.seats > 3 ? { seats: 'too many' } : {}),
  onSubmit: (values) => { window.submitted = values; },
});
form(root.querySelector('form'));
felteControl(root.querySelector('#seats'), createField('seats'));
data.subscribe((d) => { root.querySelector('#watched').textContent = String(d.seats); });
touched.subscribe((t) => { root.querySelector('#touched').textContent = t.seats ? 'seats' : ''; });
errors.subscribe((e) => { root.querySelector('#error').textContent = e.seats ? String(e.seats) : ''; });
window.form = { reset };
`;

const sameRuntime = {
  name: 'same-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^@zubra\/runtime$/ }, () => ({ path: join(src, 'index.js') }));
    builder.onResolve({ filter: /^\/[a-z-]+\.js$/ }, (args) => ({ path: join(site, args.path) }));
  },
};

async function bundle(name, source) {
  const entry = join(site, `${name}.entry.jsx`);
  writeFileSync(entry, source);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile: join(site, `${name}.js`),
    jsx: 'automatic', plugins: [sameRuntime], logLevel: 'error',
    nodePaths: [join(here, '../../node_modules')],
    define: {
      'process.env.NODE_ENV': '"development"',
      __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
}

const APPS = { 'forms-rhf': RHF_APP, 'forms-tanstack': TANSTACK_APP, 'forms-vee': VEE_APP, 'forms-felte': FELTE_APP };
before(async () => {
  for (const [name, source] of Object.entries(APPS)) await bundle(name, source);
});

const settle = (page) => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 30)));
const text = (page, id) => page.textContent(`#${id}`);
const shown = (page) => page.textContent('#seats output');

for (const name of Object.keys(APPS)) {
  test(`${name}: the library reads, validates, blurs and resets a Zubra control`, async () => {
    const { page, messages } = await open('<div id="root"></div>', { modules: [name] });
    await page.waitForSelector('#seats output');
    await settle(page);
    assert.equal(await shown(page), '2', 'the control starts at the form\'s default');
    assert.match(await text(page, 'watched'), /^2/);

    await page.click('#seats .up');
    await settle(page);
    assert.match(await text(page, 'watched'), /^3/, 'a change in the control reaches the library');
    assert.equal(await text(page, 'touched'), '', 'not touched while focus is inside');

    await page.click('#seats .up');
    await page.focus('#submit');
    await settle(page);
    assert.match(await text(page, 'touched'), /seats/, 'focus leaving the control is a blur');
    assert.equal(await text(page, 'error'), 'too many', 'the library validated the value');

    await page.click('#seats .down');
    await page.focus('#submit');
    await settle(page);
    assert.equal(await text(page, 'error'), '');
    await page.click('#submit');
    await settle(page);
    assert.equal(await page.evaluate(() => window.submitted.seats), 3, 'submitted with the control\'s value');

    await page.evaluate(() => window.form.reset());
    await settle(page);
    assert.equal(await shown(page), '2', 'reset() writes the default back into the control');
    assert.match(await text(page, 'watched'), /^2/);
    if (name === 'forms-rhf') {
      await page.click('#guests .up');
      await settle(page);
      assert.equal(await text(page, 'watched'), '2,3', 'the Controller field follows its control too');
    }
    assert.deepEqual(messages.filter((m) => !m.includes('React DevTools')), []);
  });
}
