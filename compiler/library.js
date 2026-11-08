// Library mode: compile a folder of components into a package anyone can install and use, with
// no bundler or mnx tooling on their side.
//
//   import { buildLibrary } from '@mnx/compiler/library';
//   buildLibrary('src/components', { out: 'dist', name: '@acme/ui', version: '1.0.0' });
//
// (or `npx mnx build --lib src/components`). The output:
//
//   <name>.js, <name>.d.ts        each element: an ES module importing @mnx/runtime
//   index.js, index.d.ts          every element, by its class name
//   react/…, vue/…                each element as a React or Vue component, typed
//   custom-elements.json          the Custom Elements Manifest (Storybook, IDEs, docs tools)
//   skills/using-<name>/SKILL.md  how to use the components, for coding agents, from the manifest
//   package.json                  exports for all of the above
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { compileFile } from './index.js';

const SOURCE = /\.mnx(?:\.[jt]sx)?$/;
const { version: compilerVersion } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const walk = (dir) => readdirSync(dir).sort().flatMap((entry) => {
  const path = join(dir, entry);
  if (statSync(path).isDirectory()) return entry === 'node_modules' || entry.startsWith('.') ? [] : walk(path);
  return SOURCE.test(entry) ? [path] : [];
});

const pascal = (tag) => tag.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
const posix = (path) => path.split(sep).join('/');

/**
 * Compile every component under `dir` into a package in `out`. Returns
 * `{ components: [{ tag, name, module }], warnings }`; throws on the first compile error.
 */
export function buildLibrary(dir, options = {}) {
  const root = resolve(dir);
  const target = resolve(options.out ?? 'dist');
  // Built next to the target and swapped in at the end, so a compile error leaves the last good
  // build in place (`--watch`).
  const out = `${target}.building`;
  const runtime = options.runtime ?? '@mnx/runtime';
  const sources = walk(root);
  if (!sources.length) throw new Error(`mnx build --lib: no components (.mnx, .mnx.jsx, .mnx.tsx) in ${dir}`);
  if (target === root || root.startsWith(target + sep)) throw new Error('mnx build --lib: the output directory must not contain the components');
  rmSync(out, { recursive: true, force: true });
  try {
    return finish(build());
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
  function finish(result) {
    rmSync(target, { recursive: true, force: true });
    renameSync(out, target);
    return result;
  }
  function build() {

  const write = (path, text) => {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  };
  const compile = (path, options) => {
    const response = compileFile(path, { runtime, ...options });
    if (!response.ok) throw new Error(response.error);
    return response;
  };

  const components = [];
  const warnings = [];
  const modules = [];
  for (const path of sources) {
    const module = posix(relative(root, path)).replace(SOURCE, '');
    const js = compile(path, { emit: 'js' });
    warnings.push(...js.warnings);
    const manifest = JSON.parse(compile(path, { emit: 'manifest', modulePath: `${module}.js` }).output);
    const declaration = manifest.modules[0].declarations.find((item) => item.customElement);
    const tag = declaration.tagName;
    const name = declaration.name ?? pascal(tag);
    modules.push(...manifest.modules);
    const face = JSON.parse(compile(path, { emit: 'interface' }).output);
    components.push({ tag, name, module, declaration, interface: face });

    // The element, also exported by its class name (as its typings declare).
    write(`${module}.js`, `${js.output.replace(/^export default \$define\(/m, 'const $element = $define(')}
export default $element;
export { $element as ${name} };
`);
    write(`${module}.d.ts`, compile(path, { emit: 'dts', framework: 'none' }).output);
    const up = '../'.repeat(module.split('/').length);
    for (const framework of ['react', 'vue']) {
      // React's entries are client components (they use hooks): React Server Components need
      // the directive to import them from a server component.
      const directive = framework === 'react' ? "'use client';\n" : '';
      write(`${framework}/${module}.js`, `${directive}import Element from ${JSON.stringify(`${up}${module}.js`)};
import { wrap } from ${JSON.stringify(`${runtime}/${framework}`)};

export * from ${JSON.stringify(`${up}${module}.js`)};
export default wrap(Element);
`);
      write(`${framework}/${module}.d.ts`, compile(path, { emit: 'dts', framework }).output);
    }
  }
  const tags = new Map();
  for (const component of components) {
    if (tags.has(component.tag)) throw new Error(`mnx build --lib: <${component.tag}> is defined by both ${tags.get(component.tag)} and ${component.module}`);
    tags.set(component.tag, component.module);
  }

  const index = () => components.map(({ name, module }) => `export { default as ${name} } from ${JSON.stringify(`./${module}.js`)};`).join('\n') + '\n';
  write('index.js', index());
  write('index.d.ts', index());
  for (const framework of ['react', 'vue']) {
    write(`${framework}/index.js`, (framework === 'react' ? "'use client';\n" : '') + index());
    write(`${framework}/index.d.ts`, index());
  }
  write('custom-elements.json', JSON.stringify({ schemaVersion: '2.1.0', readme: '', modules }, null, 2) + '\n');

  // package.json: what's given, then the project's own package.json, then defaults.
  const project = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {};
  const runtimeRange = `^${compilerVersion.replace(/^(\d+\.\d+)\..*/, '$1.0')}`;
  const pkg = {
    name: options.name ?? project.name ?? 'mnx-components',
    version: options.version ?? project.version ?? '0.1.0',
    ...(project.description ? { description: project.description } : {}),
    ...(project.license ? { license: project.license } : {}),
    type: 'module',
    main: './index.js',
    types: './index.d.ts',
    customElements: './custom-elements.json',
    // Importing a module defines its element.
    sideEffects: ['./*.js', './**/*.js'],
    exports: {
      '.': { types: './index.d.ts', default: './index.js' },
      './react': { types: './react/index.d.ts', default: './react/index.js' },
      './vue': { types: './vue/index.d.ts', default: './vue/index.js' },
      './custom-elements.json': './custom-elements.json',
      './package.json': './package.json',
      ...Object.fromEntries(components.flatMap(({ module }) => [
        [`./${module}`, { types: `./${module}.d.ts`, default: `./${module}.js` }],
        [`./react/${module}`, { types: `./react/${module}.d.ts`, default: `./react/${module}.js` }],
        [`./vue/${module}`, { types: `./vue/${module}.d.ts`, default: `./vue/${module}.js` }],
      ])),
    },
    peerDependencies: { [runtime]: runtimeRange, react: '>=18', vue: '>=3.3' },
    peerDependenciesMeta: { react: { optional: true }, vue: { optional: true } },
  };
  write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  // A skill for coding agents: how to use this library's components, from the manifest, so an
  // agent needn't read the modules to learn the props, events and slots.
  write(`skills/${skillName(pkg.name)}/SKILL.md`, skill(pkg.name, components));
  return { components: components.map(({ tag, name, module }) => ({ tag, name, module })), warnings };
  }
}

const skillName = (name) => `using-${name.replace(/^@/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`;

/** The library's skill: one section per component, from its manifest declaration and interface. */
function skill(name, components) {
  const code = (text) => `\`${text}\``;
  const sections = components.map(({ tag, name: className, module, declaration, interface: face }) => {
    const props = face.props ?? [];
    const events = declaration.events ?? [];
    const slots = (declaration.slots ?? []).map((slot) => slot.name || 'default');
    const model = props.filter((prop) => prop.model).map((prop) => prop.name);
    const lines = [`### ${code(`<${tag}>`)}`, ''];
    if (declaration.description) lines.push(declaration.description.replace(/\s*\n\s*/g, ' '), '');
    lines.push(`Import ${code(`${name}/${module}`)} (the element, also exported as ${code(className)}), ${code(`${name}/react/${module}`)} (a React component) or ${code(`${name}/vue/${module}`)} (a Vue component).`, '');
    if (props.length) {
      lines.push('| Prop | Type | Default | |', '|---|---|---|---|');
      for (const prop of props) {
        const note = [prop.required ? 'required' : '', prop.model ? `two-way: fires ${code(`${prop.name}change`)}` : ''].filter(Boolean).join('; ');
        lines.push(`| ${code(prop.name)} | ${code(prop.type ?? 'unknown')} | ${prop.required ? '' : code(JSON.stringify(prop.default))} | ${note} |`);
      }
      lines.push('');
    }
    if (events.length) {
      lines.push('Events (bubbling `CustomEvent`s, data in `detail`):', '');
      for (const event of events) lines.push(`- ${code(event.name)} (${code(event.type?.text ?? 'CustomEvent')})${event.description ? `: ${event.description.replace(/\s*\n\s*/g, ' ')}` : ''}`);
      lines.push('');
    }
    if (slots.length) lines.push(`Slots: ${slots.map((slot) => code(slot)).join(', ')}.`, '');
    if (face.form) lines.push('A form control: give it a `name` and it submits with the form, validates, and resets.', '');
    if (model.length) lines.push(`Two-way binding: ${model.map((prop) => `${code(prop)} with ${code(`${prop}change`)}`).join(', ')} (Vue ${code('v-model')}, Svelte ${code('bind:')}, React controlled, Angular ${code('mnxModel')}).`, '');
    return lines.join('\n');
  });
  return `---
name: ${skillName(name)}
description: Use the ${name} web components (${components.map((c) => `<${c.tag}>`).join(', ')}) from React, Vue, Svelte, Solid, Angular, plain HTML or a server-rendered page. Covers each component's props, events, slots and two-way binding.
---

${name} is a library of mnx web components. Each is a standard custom element: **properties in, DOM events out, children as slots.** It works in every framework without integration code, and ${code(`${name}/react`)} and ${code(`${name}/vue`)} export ready-made wrappers.

## Steps

1. Import the component the way the app's framework reads imports: React and Vue apps import from ${code(`${name}/react`)} or ${code(`${name}/vue`)} (or the per-component path); everything else imports ${code(`${name}/<component>`)}, which defines the element, and writes the tag.
2. Pass objects and arrays as properties (every framework binding does; in raw HTML, JSON in the attribute). Listen for the event names below, lowercase, with ${code('event.detail')}.
3. Done when the component renders, a typo'd prop is a type error (typings ship with the package), and the handler receives ${code('detail')}.

| Framework | Props | Events | Two-way |
|---|---|---|---|
| React | ${code('<Tag value={v} items={list} />')} | ${code('onValueChange={(e) => e.detail}')} | ${code('value')} + ${code('onValueChange')} |
| Vue | ${code(':items="list"')} | ${code('@valuechange="…"')} | ${code('v-model')} / ${code('v-model:prop')} |
| Svelte | ${code('{value} items={list}')} | ${code('onvaluechange={…}')} | ${code('bind:value')} |
| Solid | ${code('prop:items={list}')} | ${code('on:valuechange={…}')} | ${code('prop:value')} + ${code('on:valuechange')} |
| Angular (${code('CUSTOM_ELEMENTS_SCHEMA')}) | ${code('[items]="list"')} | ${code('(valuechange)="…"')} | ${code('mnxModel [(ngModel)]')} from ${code('@mnx/runtime/angular')} |
| Plain HTML | ${code('el.items = list')} or a JSON attribute | ${code("addEventListener('valuechange', …)")} | the pair by hand |

Server rendering: the elements hydrate server HTML in place; inside Nuxt, SvelteKit, React Router, SolidStart or Next.js, use ${code('@mnx/server')}'s ${code('injectShadowRoots()')} (see https://github.com/journey-to-code-org/open.mnx/blob/main/docs/server-rendering.md).

## Components

${sections.join('\n\n')}

The full manifest is ${code('custom-elements.json')} in this package.
`;
}
