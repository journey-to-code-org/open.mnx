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

export { findCompiler };

findCompiler(); // (points @zubra/compiler at a native CLI when its WebAssembly build is missing)
const compiler = await import('@zubra/compiler');

const SOURCE = /\.zb(?:\.[jt]sx)?$/;
const posix = (path) => path.split(sep).join('/');
const escapeAttribute = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

/**
 * `components`: the folder of `.zb` (and `.zb.jsx`/`.zb.tsx`) files. `prefix`: the URL path
 * the browser modules are served under. `cache`: keep compiled output (turn it off in
 * development to pick up edits). `production`: serve the runtime's production build, without hot
 * reloading (by default when `NODE_ENV` is `production`). `devtools`: compile for the Zubra DevTools
 * extension and serve the runtime build it reads (on by default except in production;
 * `ZUBRA_DEVTOOLS=1` turns it on there too, for a demo or a staging site). `imports`: more import map entries,
 * for packages the components import beyond `@zubra/runtime` and `@zubra/sync` (both of which
 * are served and mapped by themselves).
 */
export function createZubra({ components = 'components', prefix = '/_zubra', cache = true, production = process.env.NODE_ENV === 'production', devtools = process.env.ZUBRA_DEVTOOLS === '1' || !production, imports = {} } = {}) {
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
      throw new Error(`@zubra/server: ${relative(process.cwd(), pathOf(name))} starts with 'use collection', which needs @zubra/sync. Install it: npm install @zubra/sync`);
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

  const memo = new Map();
  const once = (key, make) => {
    if (!cache || !memo.has(key)) memo.set(key, make());
    return memo.get(key);
  };
  const need = () => compiler;
  const pathOf = (name) => {
    const path = files.get(name) ?? files.get(byTag().get(name));
    if (!path) throw new Error(`@zubra/server: no component "${name}" in ${root} (have: ${[...files.keys()].join(', ')})`);
    return path;
  };
  const sourcesOf = (path) => once(`sources:${path}`, () => need().sources(path));
  const call = (path, body) => {
    const response = need().request({ path, files: sourcesOf(path), ...body });
    if (!response.ok) throw new Error(response.error);
    return response.output;
  };

  /** Each component's interface: `{ tag, shadow, form, props: [{ name, attribute, type, default, model }] }`. */
  const describe = (name) => once(`interface:${name}`, () => JSON.parse(call(pathOf(name), { emit: 'interface' })));
  const byTag = () => once('tags', () => new Map([...files.keys()].map((name) => [describe(name).tag, name])));
  const nameOf = (nameOrTag) => (files.has(nameOrTag) ? nameOrTag : byTag().get(nameOrTag));

  const render = (name, props = {}, slots = {}, pending = []) =>
    call(pathOf(name), { emit: 'html', props, slots, slotSource: 'html', partial: true, ...(pending.length ? { pending } : {}) });
  const css = (name) => once(`css:${name}`, () => call(pathOf(name), { emit: 'css' }));
  const js = (name) => once(`js:${name}`, () => {
    const response = need().compileFile(pathOf(name), { emit: 'js', runtime: '@zubra/runtime', devtools });
    if (!response.ok) throw new Error(response.error);
    return needs(name, response.output);
  });

  const importMap = () => `<script type="importmap">${JSON.stringify({ imports: { '@zubra/runtime': `${base}/runtime/index.js`, '@zubra/runtime/spread': `${base}/runtime/spread.js`, '@zubra/runtime/primitives': `${base}/runtime/primitives.js`, '@zubra/runtime/motion': `${base}/runtime/motion.js`, ...syncImports, ...imports } })}</script>`;
  const syncImports = syncDir ? { '@zubra/sync': `${base}/sync/index.js`, '@zubra/sync/connect': `${base}/sync/connect.js` } : {};
  const head = (names) => {
    // A component that needs a package that isn't installed fails here, while the page is built,
    // with the reason, rather than later in the browser as an unresolved import.
    for (const name of names) js(name);
    const styles = names.map(css).join('\n');
    return `${styles ? `<style data-zb-components>${styles}</style>\n` : ''}${importMap()}`;
  };
  const scripts = (names, async = false) => (names.length ? `<script type="module"${async ? ' async' : ''}>${names.map((name) => `import '${base}/components/${name}.js';`).join(' ')}</script>` : '');

  /** What a request for `pathname` gets: `{ status, type, body }`, or null if it isn't ours. */
  function serve(pathname) {
    if (!pathname.startsWith(`${base}/`)) return null;
    const rest = decodeURIComponent(pathname.slice(base.length + 1));
    if (rest.startsWith('components/') && rest.endsWith('.js')) {
      const name = rest.slice('components/'.length, -3);
      if (!files.has(name)) return { status: 404, type: 'text/plain', body: 'Not found' };
      return { status: 200, type: TYPES['.js'], body: js(name) };
    }
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
  }
  const cacheControl = cache ? 'public, max-age=3600' : 'no-cache';

  /** Node's http (and Express, Koa, Fastify's raw request): true when it answered. */
  function handle(req, res) {
    const served = serve(new URL(req.url, 'http://x').pathname);
    if (!served) return false;
    res.writeHead(served.status, { 'content-type': served.type, 'cache-control': cacheControl });
    res.end(served.body);
    return true;
  }

  /** Fetch-style servers: a Response for our paths, or null. */
  async function fetchHandler(request) {
    const served = serve(new URL(request.url).pathname);
    if (!served) return null;
    return new Response(served.body, { status: served.status, headers: { 'content-type': served.type, 'cache-control': cacheControl } });
  }

  /** One page: render components into it, then `finish()` it (or use `head()` and `scripts()`). */
  function page() {
    const used = [];
    const use = (name) => {
      if (!used.includes(name)) used.push(name);
    };
    // Streaming (3.3): a prop given as a promise renders as pending (its `zb-await` shows its
    // pending content, in an empty region), and `stream()` sends the resolved region after the
    // page, with the value, for the element to hydrate.
    const pendingRenders = [];
    let streamed = 0;
    return {
      used,
      render(name, props = {}, slots) {
        const key = nameOf(name) ?? name;
        use(key);
        const promises = Object.entries(props).filter(([, value]) => value && typeof value.then === 'function');
        if (!promises.length) return render(key, props, slots);
        const given = Object.fromEntries(Object.entries(props).filter(([, value]) => !(value && typeof value.then === 'function')));
        const names = promises.map(([name]) => name);
        const id = String(streamed++);
        const shell = withStreamId(render(key, given, slots, names), id);
        const entry = { key, id, given, slots, promises: new Map(promises), shell, count: 0 };
        // Each pending region is a named range (`<?start name>`…`<?end>`) that a streamed
        // `<template for>` replaces (out-of-order streaming).
        entry.names = pendingRegions(shell).map(() => `zb-${id}-${entry.count++}`);
        pendingRenders.push(entry);
        // Until the values arrive, the element (should it start first) holds a promise for
        // each, set before it upgrades, so its `zb-await` shows the pending content.
        return `${named(shell, entry.names)}<script>(${holdInBrowser.toString()})(${JSON.stringify(id)},${JSON.stringify(names)})</script>`;
      },
      /** Whether a rendered component is waiting on a promise prop (then `stream()`, not `finish()`). */
      get pending() {
        return pendingRenders.length > 0;
      },
      /**
       * The page as a stream: `finish(html)` first, then, as each promise prop settles, the
       * resolved regions, each in a `<template for>` (which the browser puts in place itself
       * where it streams out of order), and a short inline script that hands the element the
       * value, and puts the regions in place where the browser didn't.
       * `stream(html)` is a Node Readable; `streamResponse(html)` a web `Response` body.
       */
      stream(html) {
        const { Readable } = nodeStream;
        return Readable.from(chunks(html));
      },
      streamResponse(html, init = {}) {
        const { Readable } = nodeStream;
        const body = Readable.toWeb(Readable.from(chunks(html)));
        return new Response(body, { ...init, headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers } });
      },
      /** The components' CSS and the import map, for the page's `<head>`. */
      head: () => head(used),
      /** The module script that makes the components interactive, for the end of `<body>`. */
      scripts: () => scripts(used),
      /** A whole page with the head and scripts put in (before `</head>` and `</body>`). */
      finish(html) {
        return insertBefore(insertBefore(html, '</head>', head(used)), '</body>', scripts(used));
      },
    };

    async function* chunks(html) {
      // The shell: as the ordinary page, but with the module script `async`, so the elements
      // start as soon as it has loaded instead of when the stream ends (a module script is
      // deferred until the document is complete). A region that arrives after an element has
      // started reaches it as a property change.
      yield insertBefore(insertBefore(html, '</head>', head(used)), '</body>', scripts(used, true));
      const waiting = pendingRenders.splice(0).flatMap((entry) =>
        [...entry.promises].map(([name, promise]) => promise.then(
          (value) => ({ entry, name, value }),
          (error) => ({ entry, name, error: error instanceof Error ? error.message : String(error) }),
        )));
      // In the order they settle.
      const open = new Set(waiting.map((promise) => {
        const tagged = promise.then((result) => ({ result, tagged }));
        return tagged;
      }));
      while (open.size) {
        const { result, tagged } = await Promise.race(open);
        open.delete(tagged);
        const { entry, name, value, error } = result;
        if (error !== undefined) {
          yield swapScript(entry.id, null, { [name]: { error } });
          continue;
        }
        entry.given[name] = value;
        entry.promises.delete(name);
        const resolved = withStreamId(render(entry.key, entry.given, entry.slots, [...entry.promises.keys()]), entry.id);
        const swaps = new Map(regionSwaps(entry.shell, resolved).map((swap) => [swap.index, swap.html]));
        entry.shell = resolved;
        // The regions still pending keep their names; one that resolved is replaced, along with
        // its name, by the pending regions inside it.
        const regions = [];
        entry.names = entry.names.flatMap((region, index) => {
          if (!swaps.has(index)) return [region];
          const html = swaps.get(index);
          const inner = pendingRegions(html).map(() => `zb-${entry.id}-${entry.count++}`);
          regions.push({ name: region, html: named(html, inner) });
          return inner;
        });
        yield swapScript(entry.id, regions, { [name]: { value } });
      }
    }
  }

  /**
   * Shadow roots for a framework's HTML: each shadow-DOM component's host gets its
   * server-rendered template as a declarative shadow root (read from the host's `zb-props`
   * JSON, or its attributes), so it shows before JavaScript; the browser attaches it while
   * parsing, before any framework hydrates. Form-associated components with a `name` also get a
   * hidden input with their value, so the form submits without JavaScript (the element removes
   * it when it starts). Light-DOM components are left alone unless `lightDom: true` (3.3): then
   * an empty light-DOM host gets its rendered children, for frameworks that leave nodes they
   * didn't render alone while hydrating (Solid; React and Vue through their wrappers do this
   * themselves). Not for Svelte, which claims every node.
   */
  /** The components by tag (shadow-DOM ones, or all with `lightDom`), and a pattern for their hosts' start tags. */
  function shadowHosts(lightDom = false) {
    const shadowTags = new Map();
    for (const name of files.keys()) {
      const info = describe(name);
      if (info.shadow || lightDom) shadowTags.set(info.tag, { name, info });
    }
    const pattern = shadowTags.size ? new RegExp(`<(${[...shadowTags.keys()].map((tag) => tag.replace(/[-]/g, '\\-')).join('|')})(\\s[^>]*)?>`, 'g') : null;
    return { shadowTags, pattern };
  }

  function injectShadowRoots(html, { forms = true, lightDom = false } = {}) {
    const { shadowTags, pattern } = shadowHosts(lightDom);
    if (!pattern) return html;
    let out = '';
    let last = 0;
    for (const match of html.matchAll(pattern)) {
      const end = match.index + match[0].length;
      const { name, info } = shadowTags.get(match[1]);
      // Already has one (rendered by zubra, or a second pass); a light-DOM host must be empty.
      if (info.shadow ? /^\s*<template\s[^>]*shadowroot/i.test(html.slice(end, end + 200)) : !new RegExp(`^\\s*</${match[1]}>`).test(html.slice(end, end + 200))) continue;
      const props = propsFrom(match[2] ?? '', info);
      let rendered;
      try {
        rendered = render(name, props);
      } catch {
        continue; // leave it to the browser rather than break the page
      }
      const template = info.shadow ? shadowTemplate(rendered) : lightContent(rendered, match[1]);
      if (!template) continue;
      out += html.slice(last, end) + template + (forms ? fallbackInput(match[2] ?? '', info, props) : '');
      last = end;
    }
    return out + html.slice(last);
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
      writeFileSync(file, js(name));
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
    const pass = (text, flush) => {
      const all = carry + text;
      // Hold back from an unclosed `<` (a tag cut in two), and from an opened host tag whose
      // next characters might start its <template> (to not inject twice): flushing at '>'.
      const open = flush ? -1 : all.lastIndexOf('<');
      let cut = open > all.lastIndexOf('>') ? open : all.length;
      // A host's start tag near the end: what follows may be its own <template> (a React
      // wrapper renders it), so wait for more before deciding.
      const { pattern } = shadowHosts(options?.lightDom);
      if (!flush && pattern) {
        let last = null;
        for (const match of all.slice(0, cut).matchAll(pattern)) last = match;
        if (last && cut - (last.index + last[0].length) < 64) cut = last.index;
      }
      carry = all.slice(cut);
      return injectShadowRoots(all.slice(0, cut), options);
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
    module: (name) => js(nameOf(name) ?? name),
    names: [...files.keys()],
    describe: (name) => describe(nameOf(name) ?? name),
    render: (name, props, slots) => render(nameOf(name) ?? name, props, slots),
    page,
    handle,
    fetch: fetchHandler,
    importMap,
    head: (names = [...files.keys()]) => head(names),
    scripts: (names = [...files.keys()]) => scripts(names),
    injectShadowRoots,
  };
}

function insertBefore(html, marker, text) {
  if (!text) return html;
  const at = html.lastIndexOf(marker);
  return at < 0 ? html + text : html.slice(0, at) + text + html.slice(at);
}

// ---- reading a host tag ---------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#34': '"' };
const decode = (text) => text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
  if (ENTITIES[name.toLowerCase()]) return ENTITIES[name.toLowerCase()];
  if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
  return whole;
});

/** An opening tag's attributes: `{ name: value }` (a bare attribute is `""`). */
export function parseAttributes(text) {
  const attributes = {};
  const pattern = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** The props a host tag carries: `zb-props` JSON first, then each prop's attribute by its type. */
export function propsFrom(attributeText, info) {
  const attributes = parseAttributes(attributeText);
  let props = {};
  if (attributes['zb-props']) {
    try {
      props = JSON.parse(attributes['zb-props']);
    } catch {}
  }
  for (const prop of info.props) {
    if (prop.name in props || !(prop.attribute in attributes)) continue;
    const raw = attributes[prop.attribute];
    const kind = Array.isArray(prop.default) || (prop.default && typeof prop.default === 'object') ? 'json' : prop.type;
    if (kind === 'number') {
      const number = Number(raw);
      if (raw.trim() !== '' && Number.isFinite(number)) props[prop.name] = number;
    } else if (kind === 'boolean') {
      props[prop.name] = raw !== 'false';
    } else if (kind === 'json' || /\[\]$|^\{/.test(prop.type)) {
      if (raw === '[object Object]') continue; // Svelte's SSR: the real value comes later
      try {
        props[prop.name] = JSON.parse(raw);
      } catch {}
    } else {
      props[prop.name] = raw;
    }
  }
  return props;
}

/** The `<template shadowrootmode>…</template>` at the start of a rendered host's content. */
function shadowTemplate(rendered) {
  const start = rendered.search(/<template\s[^>]*shadowrootmode/i);
  if (start < 0) return null;
  const tags = /<template\b[^>]*>|<\/template>/gi;
  tags.lastIndex = start;
  let depth = 0;
  for (const match of rendered.matchAll(tags)) {
    if (match.index < start) continue;
    depth += match[0][1] === '/' ? -1 : 1;
    if (depth === 0) return rendered.slice(start, match.index + match[0].length);
  }
  return null;
}

/** The host's start tag with `data-zb-stream="<id>"`, so the stream's scripts can find it. */
function withStreamId(html, id) {
  return html.replace(/^(\s*<[a-z][\w.-]*)/, `$1 data-zb-stream="${id}"`);
}

/**
 * The pending regions of `shell` that `resolved` has rendered: `[{ index, html }]`, where
 * `index` counts the shell's top-level `<?zb [??>` regions in order and `html` is the resolved
 * region (markers included). The two renders differ only inside those regions (and the host's
 * start tag, which is compared past).
 */
function regionSwaps(shell, resolved) {
  const skipTag = (html) => html.match(/^\s*<[a-z][\w.-]*(?:\s[^>]*)?>/)?.[0].length ?? 0;
  let a = skipTag(shell);
  let b = skipTag(resolved);
  const swaps = [];
  let index = 0;
  const PENDING = '<?zb [??>';
  const regionEnd = (html, start) => {
    // From the region's opening marker to its matching `<?zb ]?>`.
    let depth = 0;
    for (const match of html.slice(start).matchAll(/<\?zb \[[?!]?\?>|<\?zb \]\?>/g)) {
      depth += match[0] === '<?zb ]?>' ? -1 : 1;
      if (depth === 0) return start + match.index + match[0].length;
    }
    return html.length;
  };
  while (a < shell.length && b < resolved.length) {
    if (shell.startsWith(PENDING, a)) {
      const endA = regionEnd(shell, a);
      const endB = regionEnd(resolved, b);
      const region = resolved.slice(b, endB);
      if (!region.startsWith(PENDING)) swaps.push({ index, html: region });
      index++;
      a = endA;
      b = endB;
      continue;
    }
    if (shell[a] !== resolved[b]) break; // not a difference this function understands
    a++;
    b++;
  }
  return swaps;
}

/**
 * The top-level pending regions of `html` (`<?zb [??>` to its `<?zb ]?>`, not inside another
 * pending region), as `[start, end]` offsets: the ones `regionSwaps` counts.
 */
function pendingRegions(html) {
  const found = [];
  let depth = 0;
  let start = -1;
  let outer = 0;
  for (const match of html.matchAll(/<\?zb (\[[?!]?|\])\?>/g)) {
    if (match[1] === ']') {
      depth--;
      if (start >= 0 && depth === outer) {
        found.push([start, match.index + match[0].length]);
        start = -1;
      }
      continue;
    }
    if (match[1] === '[?' && start < 0) {
      start = match.index;
      outer = depth;
    }
    depth++;
  }
  return found;
}

/** `html` with its top-level pending regions in named ranges, for `<template for>`. */
function named(html, names) {
  let out = html;
  pendingRegions(html).reverse().forEach(([start, end], i, all) => {
    const name = names[all.length - 1 - i];
    out = `${out.slice(0, start)}<?start name="${name}"?>${out.slice(start, end)}<?end?>${out.slice(end)}`;
  });
  return out;
}

/** The chunk for one settled promise: each resolved region in a `<template for>`, and the script. */
function swapScript(id, regions, values) {
  const templates = (regions ?? []).map((region) => `<template for="${region.name}">${region.html}</template>`).join('');
  const script = `<script>(${swapInBrowser.toString()})(${JSON.stringify(id)},${JSON.stringify(values)})</script>`;
  return `${templates}${script}\n`;
}

// Runs in the browser, inlined, right after a streamed host: a promise per pending prop, as a
// property the element captures when it upgrades, resolved by the swap script later.
function holdInBrowser(id, names) {
  var host = document.querySelector('[data-zb-stream="' + id + '"]');
  var held = (window.__zubraStream = window.__zubraStream || {});
  for (var i = 0; i < names.length; i++) {
    (function (name) {
      host[name] = new Promise(function (resolve, reject) { held[id + ':' + name] = { resolve: resolve, reject: reject }; });
    })(names[i]);
  }
}

// Runs in the browser, inlined: hand the element the values (as properties, captured when it
// upgrades), and, before it starts, put the resolved regions in place where the browser didn't:
// browsers without out-of-order streaming leave each `<template for>` as an element, and those
// with it don't reach into a shadow root. Once the element has started it renders the regions
// itself (it removed their names, so the browser has nothing to replace).
function swapInBrowser(id, values) {
  var host = document.querySelector('[data-zb-stream="' + id + '"]');
  var script = document.currentScript;
  var templates = [];
  for (var node = script && script.previousElementSibling; node && node.tagName === 'TEMPLATE' && node.hasAttribute('for'); node = node.previousElementSibling) templates.push(node);
  // A `<?start name>` or `<?end>`: a processing instruction, or the comment it parses as.
  var kind = function (node) {
    return node.nodeType === 7 ? node.target : node.nodeType === 8 ? (/^\?(start|end)\b/.exec(node.data) || [])[1] : null;
  };
  var started = host && host.matches(':state(hydrated), [data-hydrated]');
  for (var i = 0; i < templates.length; i++) {
    var template = templates[i];
    template.remove();
    if (!host || started) continue;
    var name = 'name="' + template.getAttribute('for') + '"';
    var start = null;
    var roots = host.shadowRoot ? [host.shadowRoot, host] : [host];
    for (var r = 0; r < roots.length && !start; r++) {
      var walker = document.createTreeWalker(roots[r], NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_PROCESSING_INSTRUCTION);
      for (var at = walker.nextNode(); at; at = walker.nextNode()) {
        if (kind(at) === 'start' && at.data.replace(/^\?start |\?$/g, '') === name) { start = at; break; }
      }
    }
    var end = start && start.nextSibling;
    for (var depth = 0; end; end = end.nextSibling) {
      if (kind(end) === 'start') depth++;
      else if (kind(end) === 'end' && depth-- === 0) break;
    }
    if (!end) continue;
    var range = document.createRange();
    range.setStartBefore(start);
    range.setEndAfter(end);
    range.deleteContents();
    range.insertNode(template.content);
  }
  var held = window.__zubraStream || {};
  for (var name in values) {
    var hold = held[id + ':' + name];
    if (values[name].error !== undefined) {
      var rejected = Promise.reject(new Error(values[name].error));
      rejected.catch(function () {});
      if (hold) hold.reject(new Error(values[name].error));
      else host[name] = rejected;
    } else {
      if (hold) hold.resolve(values[name].value);
      host[name] = values[name].value;
    }
    delete held[id + ':' + name];
  }
}

/** A rendered light-DOM host's children: between its start tag and its end tag. */
function lightContent(rendered, tag) {
  const open = rendered.match(/^\s*<[a-z][\w.-]*(?:\s[^>]*)?>/);
  const close = rendered.lastIndexOf(`</${tag}>`);
  if (!open || close < open[0].length) return null;
  return rendered.slice(open[0].length, close);
}

/** A form-associated component's value, as the form would submit it, in a hidden input. */
function fallbackInput(attributeText, info, props) {
  if (!info.form) return '';
  const name = parseAttributes(attributeText).name;
  const models = info.props.filter((prop) => prop.model);
  if (!name || models.length !== 1) return '';
  const value = models[0].name in props ? props[models[0].name] : models[0].default;
  if (value == null || value === false || value === '') return '';
  const text = value === true ? 'on' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(text)}" data-zb-fallback>`;
}
