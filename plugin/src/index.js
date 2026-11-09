// @zubra/unplugin: `.zb` components in any bundler unplugin supports (Vite first).
//
//   // vite.config.js
//   import zubra from '@zubra/unplugin/vite'
//   export default { plugins: [zubra(), react()] }
//
//   // App.tsx — a React component, because this is a React file
//   import Rating from './rating.zb'
//   <Rating value={stars} onValueChange={(event) => setStars(event.detail)} />
//
// What an import of a `.zb` file gives depends on who imports it, so nobody writes glue code:
//
// - from a `.jsx`/`.tsx` file: a React component (`@zubra/runtime/react`);
// - from a `.vue` file: a Vue component (`@zubra/runtime/vue`);
// - from anything else (plain JS/TS, another `.zb`): the custom element class. In a project
//   using React or Vue, plain `.js`/`.ts` files get that framework's component.
//
// Every variant defines the element, so `<zb-rating>` also works in HTML and in templates.
// `?element`, `?react` or `?vue` on the import picks one explicitly. Compile errors show the
// source line (in Vite's overlay, too); editing a `.zb` file reloads the page, because the
// platform can't redefine a custom element. Next to each component the plugin writes typings
// (`rating.d.zb.ts`, used by TypeScript with `allowArbitraryExtensions`) for the project's
// framework.
import { createUnplugin } from 'unplugin';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { addProps, zubraImports } from './props.js';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';

const VARIANTS = ['element', 'react', 'vue'];
/** A component file: `.zb`, or a JSX component (`.zb.jsx` / `.zb.tsx`). */
const COMPONENT = /\.zb(?:\.[jt]sx)?$/;
const QUERY = '?zubra=';

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
  if (COMPONENT.test(file)) return 'element'; // a component, or a wrapper (`x.zb?zubra=react`)
  if (file.endsWith('.vue')) return 'vue';
  // JSX is React's, or Vue's in a Vue project (vue-jsx); Solid and Preact use custom elements
  // directly.
  if (/\.[jt]sx$/.test(file)) return project === 'vue' ? 'vue' : project === 'react' || project === 'element' ? 'react' : 'element';
  return project === 'react' || project === 'vue' ? project : 'element';
}

/** `.zb` files a component imports, recursively, so changing one recompiles its importers. */
function dependencies(path, seen = new Set()) {
  if (seen.has(path)) return seen;
  seen.add(path);
  let source = '';
  try { source = readFileSync(path, 'utf8'); } catch { return seen; }
  // A JSX component's imports are the whole file's; an .zb file's are its <script>'s.
  const script = /\.[jt]sx$/.test(path) ? source : source.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  for (const [, specifier] of script.matchAll(/import\s+(?:[^'"]*?from\s+)?['"]([^'"]+\.zb(?:\.[jt]sx)?)['"]/g)) {
    if (specifier.startsWith('.')) dependencies(resolve(dirname(path), specifier), seen);
  }
  return seen;
}

/**
 * A component module in Vite's dev server: it accepts its own updates, which the runtime swaps
 * into the live elements (keeping their state). An update that changes the element's interface
 * (its props, events, shadow or form setting) reloads the page instead.
 */
function hot(code) {
  // On the first line, so line numbers in errors stay the compiler's.
  return `globalThis.__ZUBRA_HOT__ = true; ${code}
if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    // (A reload, not invalidate(): a framework wrapper above accepts its own updates.)
    if (!next || next.default?.hotReloaded === false) location.reload();
  });
}
`;
}

/**
 * What a server build appends to a component: its renderer, registered by tag. It renders with
 * @zubra/compiler from the component's sources, embedded (keyed by path below their common
 * directory), so the server bundle needs nothing from the build machine.
 */
function serverRenderer(path, compilerModule, runtime) {
  const paths = [...dependencies(path)].filter((file) => existsSync(file));
  let common = dirname(path);
  while (!paths.every((file) => file.startsWith(common + sep))) common = dirname(common);
  // Imports may go up (`../x/y.zb`) before coming back down: keep the directories they pass.
  let up = 0;
  for (const file of paths) {
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/import\s+(?:[^'"]*?from\s+)?['"]((?:\.\.\/)+)[^'"]*\.zb(?:\.[jt]sx)?['"]/g)) {
      up = Math.max(up, specifier.length / 3);
    }
  }
  for (let i = 0; i < up && dirname(common) !== common; i++) common = dirname(common);
  const key = (file) => `/${relative(common, file).split(sep).join('/')}`;
  const files = Object.fromEntries(paths.map((file) => [key(file), readFileSync(file, 'utf8')]));
  return `
import { registerRenderer as $zubraRegister } from ${JSON.stringify(`${runtime}/server`)};
import { request as $zubraRequest } from ${JSON.stringify(compilerModule)};
const $zubraFiles = ${JSON.stringify(files)};
$zubraRegister(tag, (props, slots) => {
  const response = $zubraRequest({ emit: 'html', path: ${JSON.stringify(key(path))}, files: $zubraFiles, props, slots, slotSource: 'html', partial: true });
  if (!response.ok) throw new Error(response.error);
  return response.output;
});
`;
}

export const unplugin = createUnplugin((options = {}, meta = {}) => {
  // The compiler: a CLI when one is given (option or $ZUBRA_COMPILER); otherwise the WebAssembly
  // build (@zubra/compiler) if it's installed, so no Rust toolchain is needed; else `zubra` on PATH.
  const explicit = options.compiler ?? process.env.ZUBRA_COMPILER;
  const compiler = explicit ?? 'zubra';
  let wasm = null;
  async function chooseBackend() {
    if (explicit || wasm) return;
    try {
      const module = await import('@zubra/compiler');
      if (module.available()) wasm = module;
    } catch {
      // Not installed: use the CLI.
    }
  }
  const runtime = options.runtime ?? '@zubra/runtime';
  let project = options.framework && options.framework !== 'auto' ? options.framework : null;
  const typings = options.dts ?? true;
  // Server builds render components with @zubra/compiler at request time (`ssr: false` leaves
  // that out: the elements then render on the client only).
  const serverRendering = options.ssr ?? true;
  let ssrFramework = null; // React Router, SvelteKit or Nuxt (Vite): see the light-DOM warning
  const warnedLight = new Set();
  const relativePath = (path) => path.startsWith(process.cwd()) ? path.slice(process.cwd().length + 1) : path;
  const compilerModule = options.compilerModule ?? '@zubra/compiler';
  let dev = false; // Vite's dev server: components hot-reload

  /** CLI flags → a request for the WebAssembly compiler. */
  function asRequest(args) {
    const request = { emit: 'html' };
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--keep-imports') request.keepImports = true;
      else if (flag === '--no-imports') request.noImports = true;
      else {
        const key = { '--emit': 'emit', '--framework': 'framework', '--runtime': 'runtime', '--css-import': 'cssImport', '--css-import-inline': 'cssImportInline' }[flag];
        if (!key) throw new Error(`zubra: unexpected compiler flag ${flag}`);
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
    const result = spawnSync(compiler, ['compile', path, ...args], { encoding: 'utf8' });
    if (result.error) {
      throw new Error(`zubra: couldn't run the compiler \`${compiler}\` (${result.error.code ?? result.error.message}). `
        + 'Install @zubra/compiler (the WebAssembly build), install the CLI, or pass { compiler: "/path/to/zubra" }.');
    }
    if (result.status !== 0) throw new Error(result.stderr.trim() || `zubra: the compiler exited with ${result.status}`);
    return { code: result.stdout, warnings: result.stderr.trim() };
  }

  /**
   * A compile error for the bundler: with Vite, `loc` and `frame` put it in the dev overlay with
   * the source line and the compiler's help. Always throws: Rollup's and Vite's `error()` throw,
   * but esbuild's and Bun's (through unplugin) only record the error, and drop it when the hook
   * returns nothing.
   */
  function fail(context, error, id) {
    const text = String(error.message ?? error);
    const at = text.match(/-->\s+(.+?):(\d+):(\d+)/);
    const message = text.split('\n')[0].replace(/^error:\s*/, '');
    if (!at) context.error(text);
    else {
      context.error({
        message: `${message}\n\n${text}`,
        id,
        loc: { file: at[1], line: Number(at[2]), column: Number(at[3]) },
        frame: text.split('\n').slice(1).join('\n'),
        plugin: 'zubra',
      });
    }
    throw new Error(text);
  }

  // Each component's tag and prop names, for `zb-props` (by path, while its file is unchanged).
  const interfaces = new Map();
  function interfaceOf(path) {
    const stamp = statSync(path).mtimeMs;
    const known = interfaces.get(path);
    if (known?.stamp === stamp) return known.value;
    const description = JSON.parse(compile(path, '--emit', 'interface').code);
    const value = { tag: description.tag, props: new Set(description.props.map((prop) => prop.name)) };
    interfaces.set(path, { stamp, value });
    return value;
  }

  function writeTypings(path) {
    const framework = ['react', 'vue', 'svelte', 'solid'].includes(project) ? project : 'none';
    const target = resolve(dirname(path), `${basename(path, '.zb')}.d.zb.ts`);
    const contents = compile(path, '--emit', 'dts', '--framework', framework).code;
    // Only when changed, so watchers don't loop.
    if (!existsSync(target) || readFileSync(target, 'utf8') !== contents) writeFileSync(target, contents);
  }

  return {
    name: 'zubra',
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
      if (new URLSearchParams(query).get('zubra') === 'style') return `${path}?${query}`;
      // A variant already chosen (a wrapper's import of its element, a dev server URL) stays.
      const variant = new URLSearchParams(query).get('zubra') ?? variantFor(query, importer, project ?? 'element');
      return `${path}${QUERY}${variant}`;
    },

    loadInclude(id) {
      return /\.zb(?:\.[jt]sx)?\?zubra=/.test(id);
    },

    load(id, loadOptions) {
      // A server build (Vite's SSR, or its server environments): the module also registers its
      // server renderer.
      const server = loadOptions?.ssr === true || this?.environment?.config?.consumer === 'server';
      const [path, query] = split(id);
      const variant = new URLSearchParams(query).get('zubra');
      if (variant === 'style') {
        // This component's stylesheet, for the bundler's CSS pipeline (PostCSS, Tailwind,
        // preprocessors) to process.
        try {
          return compile(path, '--emit', 'css', '--no-imports').code;
        } catch (error) {
          return fail(this, error, path);
        }
      }
      if (variant === 'react' || variant === 'vue') {
        const element = JSON.stringify(`${path}${QUERY}element`);
        // In development the wrapper accepts its updates: the element it wraps hot-reloads itself.
        return `import Element from ${element};\nimport { wrap } from ${JSON.stringify(`${runtime}/${variant}`)};\n`
          + `export { tag } from ${element};\nexport default wrap(Element);\n`
          + (dev && meta.framework === 'vite' ? 'if (import.meta.hot) import.meta.hot.accept(() => {});\n' : '');
      }
      for (const dependency of dependencies(path)) this.addWatchFile?.(dependency);
      if (server && ssrFramework && path.endsWith('.zb') && !warnedLight.has(path) && isLightDom(readFileSync(path, 'utf8'))) {
        warnedLight.add(path);
        // Since 3.3 the React and Vue wrappers server-render a light-DOM element's content and
        // keep the framework out of the host while hydrating, so light DOM works there when the
        // element is given no framework children. Svelte uses the element directly, claims every
        // node, and fails on the element's own.
        if (ssrFramework === 'SvelteKit') {
          this.warn(`${relativePath(path)} is a light-DOM component, and SvelteKit hydrates the server's HTML: when the element renders into its host first, Svelte fails to hydrate the page. `
            + 'Add `shadow` to its host tag (see examples/meta/README.md).');
        } else {
          this.warn(`${relativePath(path)} is a light-DOM component: in ${ssrFramework}, that works when the element is given no children from ${ssrFramework === 'Nuxt' ? 'Vue' : 'React'} (its content is server-rendered and hydrated in place); `
            + `an element given children must be \`shadow\`, or ${ssrFramework === 'Nuxt' ? 'Vue removes what it finds there' : 'React re-renders the page'} (see examples/meta/README.md).`);
        }
      }
      // (A JSX component is typed by its own source: TypeScript reads the function.)
      if (typings && path.endsWith('.zb')) writeTypings(path);
      // With Vite, a <style> goes through Vite's CSS pipeline; elsewhere it's inlined as written.
      const styles = [];
      if (meta.framework === 'vite' && path.endsWith('.zb') && /<style[\s>]/i.test(readFileSync(path, 'utf8'))) {
        const lang = readFileSync(path, 'utf8').match(/<style[^>]*\slang=["']([a-z0-9]+)["']/i)?.[1] ?? 'css';
        styles.push('--css-import', `${path}?zubra=style&lang.${lang}`, '--css-import-inline', `${path}?zubra=style&inline&lang.${lang}`);
      }
      let output;
      try {
        // In Vite's dev server, what the browser DevTools panel reads: each part's place in the
        // `.zb` file and the script's signals by name (the runtime's development build reads them).
        const devtools = dev && meta.framework === 'vite' && !server ? ['--devtools'] : [];
        output = compile(path, '--emit', 'js', '--keep-imports', '--runtime', runtime, ...styles, ...devtools);
      } catch (error) {
        return fail(this, error, path);
      }
      if (output.warnings) this.warn(output.warnings);
      // 'use collection' compiles to an import of @zubra/sync: say what to install, rather than
      // leave the bundler to report an unresolved import.
      if (output.code.includes('from "@zubra/sync"')) {
        try {
          createRequire(path).resolve('@zubra/sync');
        } catch {
          return fail(this, new Error(`${relativePath(path)} starts with 'use collection', which needs @zubra/sync. Install it: npm install @zubra/sync`), path);
        }
      }
      if (server) return serverRendering ? output.code + serverRenderer(path, compilerModule, runtime) : output.code;
      return dev && meta.framework === 'vite' ? hot(output.code) : output.code;
    },

    rollup: {
      // The runtime loads remark.js (stripped markup) with a dynamic import, which is a second
      // chunk; a single-file build (`output.file`) inlines it instead of failing.
      outputOptions(outputOptions) {
        if (outputOptions.file && !outputOptions.dir && outputOptions.inlineDynamicImports === undefined) {
          return { ...outputOptions, inlineDynamicImports: true };
        }
        return null;
      },
    },

    vite: {
      config() {
        // One copy of each framework, even when @zubra/runtime is linked from elsewhere.
        return { resolve: { dedupe: ['react', 'react-dom', 'vue', '@angular/core', '@angular/common', '@angular/forms'] } };
      },
      configResolved(config) {
        const names = config.plugins.map((plugin) => plugin.name);
        // Frameworks that hydrate the server's HTML around elements (Solid doesn't mind).
        ssrFramework = names.includes('react-router') ? 'React Router'
          : names.some((name) => name.startsWith('vite-plugin-sveltekit')) ? 'SvelteKit'
            : names.some((name) => name.startsWith('nuxt:')) ? 'Nuxt' : null;
        if (project) return;
        if (names.some((name) => /^vite:react/.test(name) || name === 'react-router')) project = 'react';
        else if (names.includes('vite:vue')) project = 'vue';
        else if (names.includes('solid')) project = 'solid';
        else if (names.some((name) => name.startsWith('preact'))) project = 'preact';
        else if (names.some((name) => name.startsWith('vite-plugin-svelte'))) project = 'svelte';
        else project = 'element';
      },
      configureServer() {
        dev = true;
      },
      // Svelte and Solid use the elements directly: in their server builds, the hosts get
      // `zb-props` (see props.js), for @zubra/server's injectShadowRoots().
      async transform(code, id, transformOptions) {
        const dialect = project === 'svelte' ? 'svelte' : project === 'solid' ? 'solid' : null;
        if (!dialect) return null;
        const server = transformOptions?.ssr === true || this?.environment?.config?.consumer === 'server';
        const [path] = split(id);
        if (!server || path.includes('/node_modules/') || COMPONENT.test(path)) return null;
        if (dialect === 'svelte' ? !path.endsWith('.svelte') : !/\.[jt]sx$/.test(path)) return null;
        const tags = new Map();
        for (const specifier of zubraImports(code)) {
          const resolved = specifier.startsWith('.') ? resolve(dirname(path), specifier) : (await this.resolve(specifier, id, { skipSelf: true }))?.id;
          const file = resolved && split(resolved)[0];
          if (!file || !existsSync(file)) continue;
          try {
            const { tag, props } = interfaceOf(file);
            tags.set(tag, props);
          } catch {
            // A compile error shows when the component itself loads.
          }
        }
        const code2 = addProps(code, tags, dialect);
        return code2 == null ? null : { code: code2, map: null };
      },
    },
  };
});

/** Whether a `.zb` component renders into light DOM (no `shadow` on its host tag). */
export function isLightDom(source) {
  const markup = source.replace(/<!--[^]*?-->/g, '').replace(/<(script|style)\b[^]*?<\/\1>/gi, '');
  const host = markup.match(/<([a-z][a-z0-9]*-[a-z0-9-]*)\b([^>]*)>/i);
  return !!host && !/(^|\s)shadow(\s|=|$|\/)/.test(host[2]);
}

export default unplugin;
