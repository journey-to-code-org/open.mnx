// The manifest and type declarations the compiler writes, checked with the real tools: the
// official Custom Elements Manifest JSON schema, and the TypeScript compiler on code that should
// and should not type-check. Needs a Rust toolchain. Run with `npm run test:tools`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

let dir;
const SOURCE = `<!--
  A site header.
  Pass \`data\` as JSON in plain HTML.
-->
<script>
  const title = "Mikey Nichols"
  const data = { sample: "sample data", sampleTwo: "additional data" }
</script>
<mnx-header title={title} data={data} tags={["a"]} max-items={3} open={false} label>
  <header><h1>{title}</h1><mnx-slot name="actions"></mnx-slot><mnx-slot></mnx-slot></header>
</mnx-header>
`;

function compile(...args) {
  return execFileSync(join(repo, 'target/debug/mnix'), ['compile', join(dir, 'header.mnx'), ...args], { encoding: 'utf8' });
}

before(() => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  dir = mkdtempSync(join(tmpdir(), 'mnx-tools-'));
  writeFileSync(join(dir, 'header.mnx'), SOURCE);
  writeFileSync(join(dir, 'header.d.ts'), compile('--emit', 'dts'));
  writeFileSync(join(dir, 'header.js'), compile('--emit', 'js'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('the manifest is valid against the Custom Elements Manifest schema', () => {
  const manifest = JSON.parse(compile('--emit', 'manifest'));
  const schema = JSON.parse(readFileSync(require.resolve('custom-elements-manifest/schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const valid = ajv.validate(schema, manifest);
  assert.equal(valid, true, JSON.stringify(ajv.errors, null, 2));

  const [module] = manifest.modules;
  const [element] = module.declarations;
  assert.equal(module.path, 'header.js');
  assert.equal(element.tagName, 'mnx-header');
  assert.equal(element.customElement, true, 'without it, tools treat the class as a plain class');
  assert.equal(element.description, 'A site header.\nPass `data` as JSON in plain HTML.');
  assert.deepEqual(element.attributes.map((a) => [a.name, a.fieldName, a.type.text]), [
    ['title', 'title', 'string'],
    ['data', 'data', '{ sample: string; sampleTwo: string }'],
    ['tags', 'tags', 'string[]'],
    ['max-items', 'maxItems', 'number'],
    ['open', 'open', 'boolean'],
    ['label', 'label', 'unknown'],
  ]);
  assert.deepEqual(element.slots, [{ name: '' }, { name: 'actions' }], 'the default slot is ""');
  assert.ok(module.exports.some((e) => e.kind === 'custom-element-definition' && e.name === 'mnx-header'));
});

test('--module-path sets where the manifest says the module lives', () => {
  const manifest = JSON.parse(compile('--emit', 'manifest', '--module-path', 'dist/components/header.js'));
  assert.equal(manifest.modules[0].path, 'dist/components/header.js');
  assert.equal(manifest.modules[0].exports[0].declaration.module, 'dist/components/header.js');
});

function typecheck(name, code) {
  writeFileSync(join(dir, `${name}.ts`), code);
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext',
    '--moduleResolution', 'nodenext', '--lib', 'es2022,dom', '--skipLibCheck', 'false', join(dir, `${name}.ts`)], { encoding: 'utf8' });
  return (result.stdout + result.stderr).trim();
}

test('the declarations type-check correct usage', () => {
  const output = typecheck('good', `
    import MnxHeader, { tag, type MnxHeaderProps } from './header.js';
    const el = document.querySelector('mnx-header')!;
    el.title = 'Journey to Code';
    el.data = { sample: 'one', sampleTwo: 'two' };
    el.tags = ['x', 'y'];
    el.maxItems = 5;
    el.open = true;
    el.label = { anything: true };
    const items: number = el.maxItems;
    const created: MnxHeader = document.createElement('mnx-header');
    const props: MnxHeaderProps = { label: 'required', maxItems: 2 };
    const name: 'mnx-header' = tag;
    export async function ready() { await el.updateComplete; }
    export { items, created, props, name };
  `);
  assert.equal(output, '');
});

test('the declarations reject wrong prop types and missing required props', () => {
  const output = typecheck('bad', `
    import { type MnxHeaderProps } from './header.js';
    const el = document.querySelector('mnx-header')!;
    el.maxItems = '3';
    el.data = { sample: 1, sampleTwo: 'two' };
    el.tags = [1];
    el.open = 'yes';
    const props: MnxHeaderProps = { maxItems: 2 };
    export { props };
  `);
  const errors = output.split('\n').filter((line) => /error TS\d+/.test(line));
  assert.equal(errors.length, 5, output);
  assert.match(output, /bad\.ts\(4,5\).*Type 'string' is not assignable to type 'number'/);
  assert.match(output, /bad\.ts\(5,.*Type 'number' is not assignable to type 'string'/);
  assert.match(output, /Property 'label' is missing/);
});

test('form-associated components declare the native control API', () => {
  writeFileSync(join(dir, 'stepper.mnx'), readFileSync(join(here, '../browser/fixtures/stepper.mnx'), 'utf8'));
  writeFileSync(join(dir, 'stepper.d.ts'),
    execFileSync(join(repo, 'target/debug/mnix'), ['compile', join(dir, 'stepper.mnx'), '--emit', 'dts'], { encoding: 'utf8' }));
  const good = typecheck('form-good', `
    import './stepper.js';
    const el = document.querySelector('mnx-stepper')!;
    const form: HTMLFormElement | null = el.form;
    el.name = 'qty';
    const ok: boolean = el.checkValidity() && el.reportValidity() && el.willValidate;
    const message: string = el.validationMessage;
    export { form, ok, message };
  `);
  assert.equal(good, '');
  const bad = typecheck('form-bad', `
    import './stepper.js';
    const el = document.querySelector('mnx-stepper')!;
    el.validity = null;
    export {};
  `);
  assert.match(bad, /read-only|readonly/i);
});

test('events are in the manifest and type their listeners', () => {
  const compileFixture = (emit) => execFileSync(join(repo, 'target/debug/mnix'),
    ['compile', join(here, '../browser/fixtures/rating.mnx'), '--emit', emit], { encoding: 'utf8' });
  const manifest = JSON.parse(compileFixture('manifest'));
  const schema = JSON.parse(readFileSync(require.resolve('custom-elements-manifest/schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.equal(ajv.validate(schema, manifest), true, JSON.stringify(ajv.errors, null, 2));
  const [element] = manifest.modules[0].declarations;
  assert.deepEqual(element.events.map((event) => [event.name, event.type.text]), [
    ['beforevaluechange', 'CustomEvent<unknown>'],
    ['valuechange', 'CustomEvent<unknown>'],
    ['change', 'CustomEvent<null>'],
  ]);
  assert.equal(element.description, 'A two-star rating.', '@fires lines are not part of the description');

  writeFileSync(join(dir, 'rating.d.ts'), compileFixture('dts'));
  const good = typecheck('events-good', `
    import './rating.js';
    const el = document.querySelector('mnx-rating')!;
    el.addEventListener('change', (event) => { const detail: null = event.detail; void detail; });
    el.addEventListener('valuechange', (event) => { const detail: unknown = event.detail; void detail; });
    el.addEventListener('beforevaluechange', (event) => event.preventDefault());
    el.addEventListener('click', (event) => { const x: number = event.clientX; void x; });
    el.addEventListener('anything', () => {});
    el.removeEventListener('change', () => {});
    export {};
  `);
  assert.equal(good, '');
  const bad = typecheck('events-bad', `
    import './rating.js';
    const el = document.querySelector('mnx-rating')!;
    el.addEventListener('change', (event) => { const detail: string = event.detail; void detail; });
    export {};
  `);
  assert.match(bad, /events-bad\.ts\(4,.*Type 'null' is not assignable to type 'string'/);
});

test("the runtime's own declarations type scripts, hooks and adapters", async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs');
  const project = join(dir, 'runtime-types');
  mkdirSync(join(project, 'node_modules/@mnx'), { recursive: true });
  symlinkSync(join(here, '../..'), join(project, 'node_modules/@mnx/runtime'));
  for (const name of ['react', 'vue', '@vue', '@types']) {
    symlinkSync(join(here, '../../node_modules', name), join(project, 'node_modules', name));
  }
  writeFileSync(join(project, 'package.json'), '{ "type": "module" }');
  const check = (name, code) => {
    writeFileSync(join(project, `${name}.ts`), code);
    const result = spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext',
      '--moduleResolution', 'nodenext', '--lib', 'es2022,dom', '--types', 'react', join(project, `${name}.ts`)], { encoding: 'utf8', cwd: project });
    return (result.stdout + result.stderr).trim();
  };
  assert.equal(check('good', `
    import { state, computed, effect, scope, watch, onMount, props, host, emit, id, createContext, provide, inject,
      formValue, validity, define, Signal, tick, adoptStyles, type MnxElementClass } from '@mnx/runtime';
    const sheets: CSSStyleSheet[] = adoptStyles('p { color: red }', new CSSStyleSheet());
    void sheets;
    import { wrap } from '@mnx/runtime/react';
    import { wrap as wrapVue, models } from '@mnx/runtime/vue';
    const count = state(0);
    const doubled = computed(() => count.get() * 2);
    const n: number = doubled.get();
    const stop: () => void = effect(() => { count.get(); return () => {}; });
    scope(() => watch(count, (next: number, previous: number) => next + previous));
    onMount(() => () => {});
    const p = props<{ value: number }>();
    p.value = 2;
    const el: HTMLElement = host();
    const kept: boolean = emit('valuechange', 1);
    const theme = createContext('light');
    provide(theme, state('dark'));
    const current: string = inject(theme).get();
    formValue(count);
    validity(() => (count.get() < 0 ? 'no' : ''));
    const watcher = new Signal.subtle.Watcher(() => {});
    watcher.watch(count);
    const Element: MnxElementClass = define('mnx-x', { props: { value: { attribute: 'value', default: 0 } }, styled: true, styles: ':host { display: block }', setup: () => [] });
    const styled: boolean = Element.mnx.styled;
    void styled;
    const tag: string = Element.mnx.tag;
    const Component = wrap(Element);
    const VueComponent = wrapVue(Element);
    const pairs = models(Element.mnx);
    export async function later() { await tick(); }
    export { n, stop, el, kept, current, tag, Component, VueComponent, pairs, id };
  `), '');
  const bad = check('bad', `
    import { state, computed, emit, inject, createContext } from '@mnx/runtime';
    const count = state(0);
    count.set('one');
    const label: string = computed(() => 1).get();
    emit(1);
    const value: number = inject(createContext('x')).get();
    export { label, value };
  `);
  assert.equal(bad.split('\n').filter((line) => /error TS\d+/.test(line)).length, 4, bad);
});

test('a TypeScript component\'s typings carry its own types', async () => {
  // As in a project: @mnx/runtime resolves from node_modules.
  const { mkdirSync, symlinkSync, existsSync } = await import('node:fs');
  mkdirSync(join(dir, 'node_modules/@mnx'), { recursive: true });
  if (!existsSync(join(dir, 'node_modules/@mnx/runtime'))) symlinkSync(join(here, '../..'), join(dir, 'node_modules/@mnx/runtime'));
  const dts = execFileSync(join(repo, 'target/debug/mnix'), ['compile', join(here, '../browser/fixtures/typed.mnx'), '--emit', 'dts'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'typed.d.ts'), dts);
  const good = typecheck('typed-good', `
    import { type Picked, type Option } from './typed.js';
    const el = document.querySelector('mnx-typed')!;
    const first: Option = el.options[0];
    el.addEventListener('pick', (event) => {
      const picked: Picked = event.detail;
      const label: string = picked.option.label;
      void label;
    });
    export { first };
  `);
  assert.equal(good, '');
  const bad = typecheck('typed-bad', `
    import './typed.js';
    const el = document.querySelector('mnx-typed')!;
    el.options = [{ id: 'one', label: 'One' }];
    el.addEventListener('pick', (event) => { const n: number = event.detail.option.label; void n; });
    export {};
  `);
  assert.equal(bad.split('\n').filter((line) => /error TS\d+/.test(line)).length, 2, bad);
});
