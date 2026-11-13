// @zubra/server without a disk: for Cloudflare Workers, Deno and anything else that has no
// components folder to read. You give it the compiler's WebAssembly module and the components'
// sources (a bundler's text imports, or strings), and it does what `createZubra` does for Node:
//
//   import wasm from '@zubra/compiler/zubra.wasm';
//   import priceTag from './components/price-tag.zb';       // a Text rule in wrangler.jsonc
//   import { createZubra } from '@zubra/server/edge';
//
//   const zubra = createZubra({ wasm, components: { 'price-tag': priceTag } });
//   export default { fetch: async (request) => (await zubra.fetch(request)) ?? new Response(zubra.page().finish(...)) };
//
// The runtime (`@zubra/runtime`) is not served from here: there is no disk to serve it from. Put its
// files where your static assets are (Workers' `assets` directory) under `<prefix>/runtime/`, or point
// the import map at a CDN with `imports`. Everything else, including streaming (`page().streamResponse`)
// and `injectShadowRoots`, is the Node entry's, from the same code (`core.js`).
import { createCompiler } from '@zubra/compiler/wasm';
import { createCore, parseAttributes, propsFrom, SOURCE_EXTENSION } from './core.js';

export { parseAttributes, propsFrom };

/** `a/b/../c.zb` → `a/c.zb`, for the imports between components (always "/"-separated here). */
function normalize(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/**
 * `wasm`: the compiler's WebAssembly module (or `compiler`: an already made `createCompiler(…)`).
 * `components`: `{ name: source }`, where a name is the path without its extension (`forms/field`),
 * or with it (`forms/field.zb`, `card.zb.tsx`) when the extension isn't `.zb`. Components import
 * each other by relative path, as they do on disk. The other options are `createZubra`'s: `prefix`,
 * `cache`, `devtools` (off by default here: the DevTools need the runtime's development build,
 * which you would have to serve yourself) and `imports`.
 */
export function createZubra({ wasm, compiler = wasm ? createCompiler(wasm) : null, components = {}, prefix = '/_zubra', cache = true, devtools = false, imports = {}, warn, gaps, clientModules, inline } = {}) {
  if (!compiler) throw new Error("@zubra/server/edge: createZubra() needs the compiler's WebAssembly module (`wasm`), or a `compiler` from createCompiler()");
  const sources = new Map(); // path → source
  const files = new Map(); // name → path
  // In the order a folder walk finds them (each folder's entries sorted by name, a folder where its
  // name falls), so the CSS in head() comes out in the same order as the Node entry's.
  const entries = Object.entries(components).map(([key, source]) => {
    const name = key.replace(SOURCE_EXTENSION, '').replace(/^\/+/, '');
    const extension = key.match(SOURCE_EXTENSION)?.[0] ?? '.zb';
    return { name, path: `/components/${name}${extension}`, source: String(source) };
  });
  const segments = (entry) => entry.path.slice('/components/'.length).split('/');
  entries.sort((a, b) => {
    const x = segments(a);
    const y = segments(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return x.length - y.length;
  });
  for (const { name, path, source } of entries) {
    sources.set(path, source);
    files.set(name, path);
  }

  // The component and the components it imports, by path: the rule @zubra/compiler's sources() follows on disk.
  function sourcesOf(path, found = {}) {
    if (path in found || !sources.has(path)) return found;
    const source = sources.get(path);
    found[path] = source;
    const script = /\.[jt]sx$/.test(path) ? source : source.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
    for (const [, specifier] of script.matchAll(/import\s+(?:[^'"]*?from\s+)?['"]([^'"]+\.zb(?:\.[jt]sx)?)['"]/g)) {
      if (specifier.startsWith('.')) sourcesOf(normalize(`${path.slice(0, path.lastIndexOf('/'))}/${specifier}`), found);
    }
    return found;
  }

  return createCore({
    warn,
    gaps,
    clientModules,
    inline,
    request: (body) => compiler.request(body),
    files,
    sourcesOf: (path) => sourcesOf(path),
    cache,
    devtools,
    base: prefix.replace(/\/$/, ''),
    imports,
    where: 'the components given to createZubra()',
  });
}
