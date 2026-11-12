// @zubra/server: zubra components in a server's pages, with any template engine and no bundler.
//
//   import { createZubra } from '@zubra/server';
//   const zubra = createZubra({ components: 'components' });
//
//   const page = zubra.page();                       // one per request
//   const body = `<h1>Tickets</h1>${page.render('ticket-table', { tickets })}`;
//   res.end(page.finish(layout(body)));            // the components' CSS and modules go in
//
//   zubra.handle(req, res)    // Node: serves /_zubra/… (component modules, @zubra/runtime); false otherwise
//   zubra.fetch(request)      // the same for fetch-style servers (Hono, Bun, Deno): a Response or null
//
// And for frameworks that render the host tags themselves (React Router, Nuxt, SvelteKit,
// SolidStart, Next): `zubra.injectShadowRoots(html)` puts each shadow-DOM component's
// server-rendered template into the page as a declarative shadow root, and gives
// form-associated ones a hidden input, so the page is complete before JavaScript.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import * as nodeStream from 'node:stream';
const { Transform } = nodeStream;
import { findCompiler } from './compiler.js';
import { createCore, joinPath, parseAttributes, propsFrom, SOURCE_EXTENSION as SOURCE, TYPES } from './core.js';

export { findCompiler, parseAttributes, propsFrom };

findCompiler(); // (points @zubra/compiler at a native CLI when its WebAssembly build is missing)
const compiler = await import('@zubra/compiler');

const posix = (path) => path.split(sep).join('/');

/**
 * `components`: the folder of `.zb` (and `.zb.jsx`/`.zb.tsx`) files. `prefix`: the URL path
 * the browser modules are served under. `cache`: keep compiled output (turn it off in
 * development to pick up edits). `production`: serve the runtime's production build, without hot
 * reloading (by default when `NODE_ENV` is `production`). `devtools`: compile for the Zubra DevTools
 * extension and serve the runtime build it reads (on by default except in production;
 * `ZUBRA_DEVTOOLS=1` turns it on there too, for a demo or a staging site). `imports`: more import map entries,
 * for packages the components import beyond `@zubra/runtime` and `@zubra/sync` (both of which
 * are served and mapped by themselves).
 *
 * Everything that doesn't need a disk is in `core.js`, shared with `edge.js` (Workers).
 */
export function createZubra({ components = 'components', packages = [], prefix = '/_zubra', cache = true, production = process.env.NODE_ENV === 'production', devtools = process.env.ZUBRA_DEVTOOLS === '1' || !production, imports = {}, warn, clientModules } = {}) {
  const root = resolve(components);
  if (!existsSync(root)) throw new Error(`@zubra/server: no components folder at ${root}`);
  const sourceDir = dirname(fileURLToPath(import.meta.resolve('@zubra/runtime')));
  const productionDir = join(sourceDir, '..', 'dist', 'production');
  // The Zubra DevTools need the runtime's development build, whose hook the production one leaves out.
  const runtimeDir = production && !devtools && existsSync(productionDir) ? productionDir : sourceDir;
  const base = prefix.replace(/\/$/, '');

  // @zubra/sync, for components that start with 'use collection': found from the components
  // folder (the app's own node_modules), served under <prefix>/sync/ and put in the import map,
  // so a page needs no setup for it. Not installed: such a component says so (`needs()`).
  const syncDir = (() => {
    for (const from of [join(root, 'noop.js'), join(process.cwd(), 'noop.js')]) {
      try {
        return dirname(createRequire(pathToFileURL(from)).resolve('@zubra/sync'));
      } catch {}
    }
    return null;
  })();
  const needs = (name, code) => {
    if (!syncDir && code.includes('from "@zubra/sync"')) {
      throw new Error(`@zubra/server: ${relative(process.cwd(), core.pathOf(name))} starts with 'use collection', which needs @zubra/sync. Install it: npm install @zubra/sync`);
    }
    return code;
  };

  // name (the path without its extension, "/"-separated) → file
  const files = new Map();
  (function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules' && !entry.startsWith('.')) walk(path);
      } else if (SOURCE.test(entry)) {
        files.set(posix(relative(root, path)).replace(SOURCE, ''), path);
      }
    }
  })(root);

  // A package's folder of components (`@acme/kit/components`), found in the node_modules above
  // the components folder, joins the same map under its specifier, and the import map sends that
  // specifier to the same route: `@acme/kit/components/cart-panel.js` →
  // `<base>/components/@acme/kit/components/cart-panel.js`.
  const packageImports = {};
  for (const specifier of packages) {
    const name = specifier.replace(/\/$/, '');
    // A folder, as `exports` would give it: `./components/` matches `./components/*`.
    const found = compiler.packageFile(root, `${name}/`);
    if (found.error) {
      if (compiler.packageFile(root, name).path) throw new Error(`@zubra/server: packages: ${name} is a file; name the folder its components are in`);
      throw new Error(`@zubra/server: packages: ${found.error}`);
    }
    const dir = found.path;
    (function walk(at) {
      for (const entry of readdirSync(at).sort()) {
        const path = join(at, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (SOURCE.test(entry)) files.set(`${name}/${posix(relative(dir, path))}`.replace(SOURCE, ''), path);
      }
    })(dir);
    packageImports[`${name}/`] = `${base}/components/${name}/`;
  }

  // What <prefix>/ serves besides the components' modules: @zubra/sync and the runtime, from disk.
  const assets = (rest) => {
    if (rest.startsWith('sync/') && syncDir) {
      const file = resolve(syncDir, rest.slice('sync/'.length));
      if (!file.startsWith(syncDir + sep) || extname(file) !== '.js' || !existsSync(file)) return { status: 404, type: 'text/plain', body: 'Not found' };
      return { status: 200, type: TYPES['.js'], body: readFileSync(file) };
    }
    if (rest.startsWith('runtime/')) {
      const file = resolve(runtimeDir, rest.slice('runtime/'.length));
      if (!file.startsWith(runtimeDir + sep) || !existsSync(file) || statSync(file).isDirectory()) return { status: 404, type: 'text/plain', body: 'Not found' };
      return { status: 200, type: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) };
    }
    return null;
  };

  const core = createCore({
    warn,
    clientModules,
    // The compiler keys a context by its module's path, joined to the importing component's.
    contextKey: ({ module, export: name }) => `${joinPath(posix(root), module)}#${name}`,
    // A `.js` file in the components folder that a component imports, served as it is.
    localModule: (path) => {
      const file = resolve(root, path);
      if (!file.startsWith(root + sep) || extname(file) !== '.js' || !existsSync(file) || statSync(file).isDirectory()) return null;
      return { status: 200, type: TYPES['.js'], body: readFileSync(file) };
    },
    request: (body) => compiler.request(body),
    files,
    sourcesOf: (path) => compiler.sources(path),
    cache,
    devtools,
    base,
    imports: { ...packageImports, ...imports },
    syncImports: syncDir ? { '@zubra/sync': `${base}/sync/index.js`, '@zubra/sync/connect': `${base}/sync/connect.js` } : {},
    needs,
    where: root,
    assets,
  });

  /** Node's http (and Express, Koa, Fastify's raw request): true when it answered. */
  function handle(req, res) {
    const served = core.serve(new URL(req.url, 'http://x').pathname);
    if (!served) return false;
    res.writeHead(served.status, { 'content-type': served.type, 'cache-control': core.cacheControl });
    res.end(served.body);
    return true;
  }

  /** One page, as in core.js, and `stream(html)`: the same chunks as a Node Readable. */
  function page() {
    const one = core.page();
    one.stream = (html) => nodeStream.Readable.from(one.chunks(html));
    return one;
  }

  /**
   * For static sites: write every component's browser module and @zubra/runtime under `dir`, at
   * the paths the pages import (`<dir>/_zubra/components/…`, `<dir>/_zubra/runtime/…`).
   */
  function writeAssets(dir) {
    const out = join(resolve(dir), ...base.split('/').filter(Boolean));
    for (const name of files.keys()) {
      const file = join(out, 'components', `${name}.js`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, core.module(name));
    }
    cpSync(runtimeDir, join(out, 'runtime'), { recursive: true });
    if (syncDir) cpSync(syncDir, join(out, 'sync'), { recursive: true, filter: (from) => !from.endsWith('.d.ts') });
  }

  /**
   * `injectShadowRoots` for a streamed page (React's renderToPipeableStream, any Node stream of
   * HTML): a Transform that passes the page through as it comes, holding back only an unfinished
   * tag at the end of a chunk until the next one completes it.
   */
  function injectShadowRootsStream(options) {
    const decoder = new StringDecoder('utf8');
    let carry = '';
    options = { ...options, hosts: { count: 0 } }; // one count of hosts for the whole stream
    const pass = (text, flush) => {
      const all = carry + text;
      // Hold back from an unclosed `<` (a tag cut in two), and from an opened host tag whose
      // next characters might start its <template> (to not inject twice): flushing at '>'.
      const open = flush ? -1 : all.lastIndexOf('<');
      let cut = open > all.lastIndexOf('>') ? open : all.length;
      // A host's start tag near the end: what follows may be its own <template> (a React
      // wrapper renders it), so wait for more before deciding.
      const { pattern } = core.shadowHosts(options?.lightDom);
      if (!flush && pattern) {
        let last = null;
        for (const match of all.slice(0, cut).matchAll(pattern)) last = match;
        if (last && cut - (last.index + last[0].length) < 64) cut = last.index;
      }
      carry = all.slice(cut);
      return core.injectShadowRoots(all.slice(0, cut), options);
    };
    return new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, pass(decoder.write(chunk), false));
      },
      flush(callback) {
        callback(null, pass(decoder.end(), true));
      },
    });
  }

  return {
    writeAssets,
    injectShadowRootsStream,
    module: core.module,
    names: core.names,
    describe: core.describe,
    render: core.render,
    page,
    handle,
    fetch: core.fetch,
    importMap: core.importMap,
    head: core.head,
    scripts: core.scripts,
    injectShadowRoots: core.injectShadowRoots,
  };
}
