// @mnx/server: mnx components in a server's pages, with any template engine and no bundler.
//
//   import { createMnx } from '@mnx/server';
//   const mnx = createMnx({ components: 'components' });
//
//   const page = mnx.page();                       // one per request
//   const body = `<h1>Tickets</h1>${page.render('ticket-table', { tickets })}`;
//   res.end(page.finish(layout(body)));            // the components' CSS and modules go in
//
//   mnx.handle(req, res)    // Node: serves /_mnx/… (component modules, @mnx/runtime); false otherwise
//   mnx.fetch(request)      // the same for fetch-style servers (Hono, Bun, Deno): a Response or null
//
// And for frameworks that render the host tags themselves (React Router, Nuxt, SvelteKit,
// SolidStart, Next): `mnx.injectShadowRoots(html)` puts each shadow-DOM component's
// server-rendered template into the page as a declarative shadow root, and gives
// form-associated ones a hidden input, so the page is complete before JavaScript.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import { findCompiler } from './compiler.js';

export { findCompiler };

findCompiler(); // (points @mnx/compiler at a native CLI when its WebAssembly build is missing)
const compiler = await import('@mnx/compiler');

const SOURCE = /\.mnx(?:\.[jt]sx)?$/;
const posix = (path) => path.split(sep).join('/');
const escapeAttribute = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

/**
 * `components`: the folder of `.mnx` (and `.mnx.jsx`/`.mnx.tsx`) files. `prefix`: the URL path
 * the browser modules are served under. `cache`: keep compiled output (turn it off in
 * development to pick up edits). `production`: serve the runtime's production build, without hot
 * reloading (by default when `NODE_ENV` is `production`).
 */
export function createMnx({ components = 'components', prefix = '/_mnx', cache = true, production = process.env.NODE_ENV === 'production' } = {}) {
  const root = resolve(components);
  if (!existsSync(root)) throw new Error(`@mnx/server: no components folder at ${root}`);
  const sourceDir = dirname(fileURLToPath(import.meta.resolve('@mnx/runtime')));
  const productionDir = join(sourceDir, '..', 'dist', 'production');
  const runtimeDir = production && existsSync(productionDir) ? productionDir : sourceDir;
  const base = prefix.replace(/\/$/, '');

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
    if (!path) throw new Error(`@mnx/server: no component "${name}" in ${root} (have: ${[...files.keys()].join(', ')})`);
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

  const render = (name, props = {}, slots = {}) =>
    call(pathOf(name), { emit: 'html', props, slots, slotSource: 'html', partial: true });
  const css = (name) => once(`css:${name}`, () => call(pathOf(name), { emit: 'css' }));
  const js = (name) => once(`js:${name}`, () => {
    const response = need().compileFile(pathOf(name), { emit: 'js', runtime: '@mnx/runtime' });
    if (!response.ok) throw new Error(response.error);
    return response.output;
  });

  const importMap = () => `<script type="importmap">${JSON.stringify({ imports: { '@mnx/runtime': `${base}/runtime/index.js` } })}</script>`;
  const head = (names) => {
    const styles = names.map(css).join('\n');
    return `${styles ? `<style data-mnx-components>${styles}</style>\n` : ''}${importMap()}`;
  };
  const scripts = (names) => (names.length ? `<script type="module">${names.map((name) => `import '${base}/components/${name}.js';`).join(' ')}</script>` : '');

  /** What a request for `pathname` gets: `{ status, type, body }`, or null if it isn't ours. */
  function serve(pathname) {
    if (!pathname.startsWith(`${base}/`)) return null;
    const rest = decodeURIComponent(pathname.slice(base.length + 1));
    if (rest.startsWith('components/') && rest.endsWith('.js')) {
      const name = rest.slice('components/'.length, -3);
      if (!files.has(name)) return { status: 404, type: 'text/plain', body: 'Not found' };
      return { status: 200, type: TYPES['.js'], body: js(name) };
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
    return {
      used,
      render(name, props, slots) {
        const key = nameOf(name) ?? name;
        const html = render(key, props, slots);
        use(key);
        return html;
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
  }

  /**
   * Shadow roots for a framework's HTML: each shadow-DOM component's host gets its
   * server-rendered template as a declarative shadow root (read from the host's `mnx-props`
   * JSON, or its attributes), so it shows before JavaScript; the browser attaches it while
   * parsing, before any framework hydrates. Form-associated components with a `name` also get a
   * hidden input with their value, so the form submits without JavaScript (the element removes
   * it when it starts). Light-DOM components are left alone: frameworks would see their markup.
   */
  function injectShadowRoots(html, { forms = true } = {}) {
    const shadowTags = new Map();
    for (const name of files.keys()) {
      const info = describe(name);
      if (info.shadow) shadowTags.set(info.tag, { name, info });
    }
    if (!shadowTags.size) return html;
    const pattern = new RegExp(`<(${[...shadowTags.keys()].map((tag) => tag.replace(/[-]/g, '\\-')).join('|')})(\\s[^>]*)?>`, 'g');
    let out = '';
    let last = 0;
    for (const match of html.matchAll(pattern)) {
      const end = match.index + match[0].length;
      // Already has one (rendered by mnx, or a second pass).
      if (/^\s*<template\s[^>]*shadowroot/i.test(html.slice(end, end + 200))) continue;
      const { name, info } = shadowTags.get(match[1]);
      const props = propsFrom(match[2] ?? '', info);
      let rendered;
      try {
        rendered = render(name, props);
      } catch {
        continue; // leave it to the browser rather than break the page
      }
      const template = shadowTemplate(rendered);
      if (!template) continue;
      out += html.slice(last, end) + template + (forms ? fallbackInput(match[2] ?? '', info, props) : '');
      last = end;
    }
    return out + html.slice(last);
  }

  /**
   * For static sites: write every component's browser module and @mnx/runtime under `dir`, at
   * the paths the pages import (`<dir>/_mnx/components/…`, `<dir>/_mnx/runtime/…`).
   */
  function writeAssets(dir) {
    const out = join(resolve(dir), ...base.split('/').filter(Boolean));
    for (const name of files.keys()) {
      const file = join(out, 'components', `${name}.js`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, js(name));
    }
    cpSync(runtimeDir, join(out, 'runtime'), { recursive: true });
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
      const cut = open > all.lastIndexOf('>') ? open : all.length;
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

/** The props a host tag carries: `mnx-props` JSON first, then each prop's attribute by its type. */
export function propsFrom(attributeText, info) {
  const attributes = parseAttributes(attributeText);
  let props = {};
  if (attributes['mnx-props']) {
    try {
      props = JSON.parse(attributes['mnx-props']);
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

/** A form-associated component's value, as the form would submit it, in a hidden input. */
function fallbackInput(attributeText, info, props) {
  if (!info.form) return '';
  const name = parseAttributes(attributeText).name;
  const models = info.props.filter((prop) => prop.model);
  if (!name || models.length !== 1) return '';
  const value = models[0].name in props ? props[models[0].name] : models[0].default;
  if (value == null || value === false || value === '') return '';
  const text = value === true ? 'on' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(text)}" data-mnx-fallback>`;
}
