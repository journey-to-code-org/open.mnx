// @mnx/unplugin: `.mnx` components in any bundler unplugin supports (Vite first).
//
//   // vite.config.js
//   import mnx from '@mnx/unplugin/vite'
//   export default { plugins: [mnx(), react()] }
//
//   // App.tsx — a React component, because this is a React file
//   import Rating from './rating.mnx'
//   <Rating value={stars} onValueChange={(event) => setStars(event.detail)} />
//
// What an import of a `.mnx` file gives depends on who imports it, so nobody writes glue code:
//
// - from a `.jsx`/`.tsx` file: a React component (`@mnx/runtime/react`);
// - from a `.vue` file: a Vue component (`@mnx/runtime/vue`);
// - from anything else (plain JS/TS, another `.mnx`): the custom element class. In a project
//   using React or Vue, plain `.js`/`.ts` files get that framework's component.
//
// Every variant defines the element, so `<mnx-rating>` also works in HTML and in templates.
// `?element`, `?react` or `?vue` on the import picks one explicitly. Compile errors show the
// source line (in Vite's overlay, too); editing a `.mnx` file reloads the page, because the
// platform can't redefine a custom element. Next to each component the plugin writes typings
// (`rating.d.mnx.ts`, used by TypeScript with `allowArbitraryExtensions`) for the project's
// framework.
import { createUnplugin } from 'unplugin';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';

const VARIANTS = ['element', 'react', 'vue'];
/** A component file: `.mnx`, or a JSX component (`.mnx.jsx` / `.mnx.tsx`). */
const COMPONENT = /\.mnx(?:\.[jt]sx)?$/;
const QUERY = '?mnx=';

const split = (id) => {
  const at = id.indexOf('?');
  return at < 0 ? [id, ''] : [id.slice(0, at), id.slice(at + 1)];
};

/** The variant an importer gets: by explicit query, by the importer's kind, or the project's. */
export function variantFor(query, importer, project) {
  const asked = VARIANTS.find((variant) => new URLSearchParams(query).has(variant));
  if (asked) return asked;
  if (!importer) return project;
  const [file] = split(importer);
  if (COMPONENT.test(file)) return 'element'; // a component, or a wrapper (`x.mnx?mnx=react`)
  if (file.endsWith('.vue')) return 'vue';
  // JSX is React's, or Vue's in a Vue project (vue-jsx); Solid and Preact use custom elements
  // directly.
  if (/\.[jt]sx$/.test(file)) return project === 'vue' ? 'vue' : project === 'react' || project === 'element' ? 'react' : 'element';
  return project === 'react' || project === 'vue' ? project : 'element';
}

/** `.mnx` files a component imports, recursively, so changing one recompiles its importers. */
function dependencies(path, seen = new Set()) {
  if (seen.has(path)) return seen;
  seen.add(path);
  let source = '';
  try { source = readFileSync(path, 'utf8'); } catch { return seen; }
  // A JSX component's imports are the whole file's; an .mnx file's are its <script>'s.
  const script = /\.[jt]sx$/.test(path) ? source : source.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  for (const [, specifier] of script.matchAll(/import\s+(?:[^'"]*?from\s+)?['"]([^'"]+\.mnx(?:\.[jt]sx)?)['"]/g)) {
    if (specifier.startsWith('.')) dependencies(resolve(dirname(path), specifier), seen);
  }
  return seen;
}

/**
 * What a server build appends to a component: its renderer, registered by tag. It renders with
 * @mnx/compiler from the component's sources, embedded (keyed by path below their common
 * directory), so the server bundle needs nothing from the build machine.
 */
function serverRenderer(path, compilerModule, runtime) {
  const paths = [...dependencies(path)].filter((file) => existsSync(file));
  let common = dirname(path);
  while (!paths.every((file) => file.startsWith(common + sep))) common = dirname(common);
  // Imports may go up (`../x/y.mnx`) before coming back down: keep the directories they pass.
  let up = 0;
  for (const file of paths) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/import\s+(?:[^'"]*?from\s+)?['"]((?:\.\.\/)+)[^'"]*\.mnx(?:\.[jt]sx)?['"]/g)) {
      up = Math.max(up, specifier.length / 3);
    }
  }
  for (let i = 0; i < up && dirname(common) !== common; i++) common = dirname(common);
  const key = (file) => `/${relative(common, file).split(sep).join('/')}`;
  const files = Object.fromEntries(paths.map((file) => [key(file), readFileSync(file, 'utf8')]));
  return `
import { registerRenderer as $mnxRegister } from ${JSON.stringify(`${runtime}/server`)};
import { request as $mnxRequest } from ${JSON.stringify(compilerModule)};
const $mnxFiles = ${JSON.stringify(files)};
$mnxRegister(tag, (props, slots) => {
  const response = $mnxRequest({ emit: 'html', path: ${JSON.stringify(key(path))}, files: $mnxFiles, props, slots, slotSource: 'html', partial: true });
  if (!response.ok) throw new Error(response.error);
  return response.output;
});
`;
}

export const unplugin = createUnplugin((options = {}, meta = {}) => {
  // The compiler: a CLI when one is given (option or $MNX_COMPILER); otherwise the WebAssembly
  // build (@mnx/compiler) if it's installed, so no Rust toolchain is needed; else `mnx` on PATH
  // (or `mnix`, its 1.x name).
  const explicit = options.compiler ?? process.env.MNX_COMPILER;
  let compiler = explicit ?? 'mnx';
  let wasm = null;
  async function chooseBackend() {
    if (explicit || wasm) return;
    try {
      const module = await import('@mnx/compiler');
      if (module.available()) wasm = module;
    } catch {
      // Not installed: use the CLI.
    }
  }
  const runtime = options.runtime ?? '@mnx/runtime';
  let project = options.framework && options.framework !== 'auto' ? options.framework : null;
  const typings = options.dts ?? true;
  // Server builds render components with @mnx/compiler at request time (`ssr: false` leaves
  // that out: the elements then render on the client only).
  const serverRendering = options.ssr ?? true;
  const compilerModule = options.compilerModule ?? '@mnx/compiler';

  /** CLI flags → a request for the WebAssembly compiler. */
  function asRequest(args) {
    const request = { emit: 'html' };
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--keep-imports') request.keepImports = true;
      else if (flag === '--no-imports') request.noImports = true;
      else {
        const key = { '--emit': 'emit', '--framework': 'framework', '--runtime': 'runtime', '--css-import': 'cssImport', '--css-import-inline': 'cssImportInline' }[flag];
        if (!key) throw new Error(`mnx: unexpected compiler flag ${flag}`);
        request[key] = args[++i];
      }
    }
    return request;
  }

  function compile(path, ...args) {
    if (wasm) {
      const response = wasm.compileFile(path, asRequest(args));
      if (!response.ok) throw new Error(response.error);
      return { code: response.output, warnings: response.warnings.join('').trim() };
    }
    let result = spawnSync(compiler, ['compile', path, ...args], { encoding: 'utf8' });
    if (result.error?.code === 'ENOENT' && !explicit && compiler === 'mnx') {
      compiler = 'mnix';
      result = spawnSync(compiler, ['compile', path, ...args], { encoding: 'utf8' });
    }
    if (result.error) {
      throw new Error(`mnx: couldn't run the compiler \`${compiler}\` (${result.error.code ?? result.error.message}). `
        + 'Install @mnx/compiler (the WebAssembly build), install the CLI, or pass { compiler: "/path/to/mnx" }.');
    }
    if (result.status !== 0) throw new Error(result.stderr.trim() || `mnx: the compiler exited with ${result.status}`);
    return { code: result.stdout, warnings: result.stderr.trim() };
  }

  function writeTypings(path) {
    const framework = ['react', 'vue', 'svelte', 'solid'].includes(project) ? project : 'none';
    const target = resolve(dirname(path), `${basename(path, '.mnx')}.d.mnx.ts`);
    const contents = compile(path, '--emit', 'dts', '--framework', framework).code;
    // Only when changed, so watchers don't loop.
    if (!existsSync(target) || readFileSync(target, 'utf8') !== contents) writeFileSync(target, contents);
  }

  return {
    name: 'mnx',
    enforce: 'pre',

    async buildStart() {
      await chooseBackend();
    },

    async resolveId(source, importer) {
      const [specifier, query] = split(source);
      if (!COMPONENT.test(specifier)) return null;
      let path;
      if (specifier.startsWith('/') && existsSync(specifier)) path = specifier;
      else if (importer && specifier.startsWith('.')) path = resolve(dirname(split(importer)[0]), specifier);
      else {
        const resolved = await this.resolve?.(specifier, importer, { skipSelf: true });
        if (!resolved) return null;
        path = split(resolved.id)[0];
      }
      // A component's stylesheet keeps its whole query: Vite (and Tailwind) recognize CSS by its
      // `&lang.css` suffix, and inline CSS by `&inline`.
      if (new URLSearchParams(query).get('mnx') === 'style') return `${path}?${query}`;
      // A variant already chosen (a wrapper's import of its element, a dev server URL) stays.
      const variant = new URLSearchParams(query).get('mnx') ?? variantFor(query, importer, project ?? 'element');
      return `${path}${QUERY}${variant}`;
    },

    loadInclude(id) {
      return /\.mnx(?:\.[jt]sx)?\?mnx=/.test(id);
    },

    load(id, loadOptions) {
      // A server build (Vite's SSR, or its server environments): the module also registers its
      // server renderer.
      const server = loadOptions?.ssr === true || this?.environment?.config?.consumer === 'server';
      const [path, query] = split(id);
      const variant = new URLSearchParams(query).get('mnx');
      if (variant === 'style') {
        // This component's stylesheet, for the bundler's CSS pipeline (PostCSS, Tailwind,
        // preprocessors) to process.
        try {
          return compile(path, '--emit', 'css', '--no-imports').code;
        } catch (error) {
          this.error(error.message);
        }
      }
      if (variant === 'react' || variant === 'vue') {
        const element = JSON.stringify(`${path}${QUERY}element`);
        return `import Element from ${element};\nimport { wrap } from ${JSON.stringify(`${runtime}/${variant}`)};\n`
          + `export { tag } from ${element};\nexport default wrap(Element);\n`;
      }
      for (const dependency of dependencies(path)) this.addWatchFile?.(dependency);
      // (A JSX component is typed by its own source: TypeScript reads the function.)
      if (typings && path.endsWith('.mnx')) writeTypings(path);
      // With Vite, a <style> goes through Vite's CSS pipeline; elsewhere it's inlined as written.
      const styles = [];
      if (meta.framework === 'vite' && path.endsWith('.mnx') && /<style[\s>]/i.test(readFileSync(path, 'utf8'))) {
        const lang = readFileSync(path, 'utf8').match(/<style[^>]*\slang=["']([a-z0-9]+)["']/i)?.[1] ?? 'css';
        styles.push('--css-import', `${path}?mnx=style&lang.${lang}`, '--css-import-inline', `${path}?mnx=style&inline&lang.${lang}`);
      }
      let output;
      try {
        output = compile(path, '--emit', 'js', '--keep-imports', '--runtime', runtime, ...styles);
      } catch (error) {
        this.error(error.message);
      }
      if (output.warnings) this.warn(output.warnings);
      return server && serverRendering ? output.code + serverRenderer(path, compilerModule, runtime) : output.code;
    },

    vite: {
      config() {
        // One copy of each framework, even when @mnx/runtime is linked from elsewhere.
        return { resolve: { dedupe: ['react', 'react-dom', 'vue'] } };
      },
      configResolved(config) {
        if (project) return;
        const names = config.plugins.map((plugin) => plugin.name);
        if (names.some((name) => /^vite:react/.test(name))) project = 'react';
        else if (names.includes('vite:vue')) project = 'vue';
        else if (names.includes('solid')) project = 'solid';
        else if (names.some((name) => name.startsWith('preact'))) project = 'preact';
        else if (names.some((name) => name.startsWith('vite-plugin-svelte'))) project = 'svelte';
        else project = 'element';
      },
      handleHotUpdate({ file, server }) {
        if (!COMPONENT.test(file)) return;
        server.ws.send({ type: 'full-reload' });
        return [];
      },
    },
  };
});

export default unplugin;
