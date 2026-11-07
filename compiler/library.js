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
//   package.json                  exports for all of the above
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  const out = resolve(options.out ?? 'dist');
  const runtime = options.runtime ?? '@mnx/runtime';
  const sources = walk(root);
  if (!sources.length) throw new Error(`mnx build --lib: no components (.mnx, .mnx.jsx, .mnx.tsx) in ${dir}`);
  if (out === root || root.startsWith(out + sep)) throw new Error('mnx build --lib: the output directory must not contain the components');
  rmSync(out, { recursive: true, force: true });

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
    components.push({ tag, name, module });

    // The element, also exported by its class name (as its typings declare).
    write(`${module}.js`, `${js.output.replace(/^export default \$define\(/m, 'const $element = $define(')}
export default $element;
export { $element as ${name} };
`);
    write(`${module}.d.ts`, compile(path, { emit: 'dts', framework: 'none' }).output);
    const up = '../'.repeat(module.split('/').length);
    for (const framework of ['react', 'vue']) {
      write(`${framework}/${module}.js`, `import Element from ${JSON.stringify(`${up}${module}.js`)};
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
    write(`${framework}/index.js`, index());
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
  return { components, warnings };
}
