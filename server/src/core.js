// The part of @zubra/server that needs no host: it takes the compiler's `request` and the
// components' paths and sources, and does everything else: rendering, CSS, browser modules, a
// page's head and scripts, streaming, and shadow roots for frameworks' HTML. It imports nothing
// from Node and never looks at `import.meta`, so it runs in Cloudflare Workers and Deno as well
// as Node. `index.js` is this plus the file system (finding the components, serving the runtime
// from disk); `edge.js` is this plus a map of sources and the compiler's WebAssembly module.

const SOURCE_EXTENSION = /\.zb(?:\.[jt]sx)?$/;
const escapeAttribute = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

export { SOURCE_EXTENSION, TYPES };

/**
 * `request(body)`: the compiler (`{ ok, output, error }`). `files`: a Map from component name
 * (the path without its extension, "/"-separated) to the path its source is known by.
 * `sourcesOf(path)`: that component's source and the sources of the components it imports, by
 * path. `where`: how an error names the place the components came from. `assets(rest)`: what the
 * host serves under `<base>/` beyond the components' modules (`{ status, type, body }` or null).
 * `needs(name, code)`: the host's check on a compiled module (a package it needs being installed).
 */
export function createCore({ request, files, sourcesOf: readSources, cache = true, devtools = false, base, imports = {}, syncImports = {}, needs = (_name, code) => code, where = 'the components', assets = () => null, warn = (message) => console.warn(message), clientModules = 'all', localModule = () => null, contextKey = ({ module, export: name }) => `${joinPath('', module)}#${name}` }) {
  if (clientModules !== 'all' && clientModules !== 'needed') throw new Error(`@zubra/server: clientModules is "all" or "needed", not ${JSON.stringify(clientModules)}`);
  const memo = new Map();
  const once = (key, make) => {
    if (!cache || !memo.has(key)) memo.set(key, make());
    return memo.get(key);
  };
  const pathOf = (name) => {
    const path = files.get(name) ?? files.get(byTag().get(name));
    if (!path) throw new Error(`@zubra/server: no component "${name}" in ${where} (have: ${[...files.keys()].join(', ')})`);
    return path;
  };
  const sourcesOf = (path) => once(`sources:${path}`, () => readSources(path));
  const call = (path, body) => {
    const response = request({ path, files: sourcesOf(path), ...body });
    if (!response.ok) throw new Error(response.error);
    return response.output;
  };

  /** Each component's interface: `{ tag, shadow, form, props: [{ name, attribute, type, default, model }] }`. */
  const describe = (name) => once(`interface:${name}`, () => JSON.parse(call(pathOf(name), { emit: 'interface' })));
  const byTag = () => once('tags', () => new Map([...files.keys()].map((name) => [describe(name).tag, name])));
  const nameOf = (nameOrTag) => (files.has(nameOrTag) ? nameOrTag : byTag().get(nameOrTag));

  // `idPrefix`: renders that end up in one page number their hosts' ids apart (`id()`).
  // `context`: the values the page provides (`page.provide()`), by context key.
  const render = (name, props = {}, slots = {}, pending = [], idPrefix = '', context = {}) => {
    const path = pathOf(name);
    const response = request({ path, files: sourcesOf(path), emit: 'html', props, slots, slotSource: 'html', partial: true, ...(pending.length ? { pending } : {}), ...(idPrefix ? { idPrefix } : {}), ...(Object.keys(context).length ? { context } : {}) });
    if (!response.ok) throw new Error(response.error);
    // A value that isn't a safe URL (a user's `javascript:` link) is left out, as the element
    // leaves it out in the browser; the page still renders, and this says what was dropped.
    for (const message of response.omitted ?? []) warn(`@zubra/server: <${name}>: ${message}`);
    return response.output;
  };
  const css = (name) => once(`css:${name}`, () => call(pathOf(name), { emit: 'css' }));
  const js = (name) => once(`js:${name}`, () => {
    const path = pathOf(name);
    const response = request({ emit: 'js', runtime: '@zubra/runtime', devtools, path, files: sourcesOf(path) });
    if (!response.ok) throw new Error(response.error);
    return needs(name, response.output);
  });

  const importMap = () => `<script type="importmap">${JSON.stringify({ imports: { '@zubra/runtime': `${base}/runtime/index.js`, '@zubra/runtime/spread': `${base}/runtime/spread.js`, '@zubra/runtime/primitives': `${base}/runtime/primitives.js`, '@zubra/runtime/motion': `${base}/runtime/motion.js`, '@zubra/runtime/track': `${base}/runtime/track.js`, ...syncImports, ...imports } })}</script>`;
  const head = (names) => {
    // A component that needs a package that isn't installed fails here, while the page is built,
    // with the reason, rather than later in the browser as an unresolved import.
    for (const name of names) js(name);
    const styles = names.map(css).join('\n');
    return `${styles ? `<style data-zb-components>${styles}</style>\n` : ''}${importMap()}`;
  };
  // `clientModules: 'needed'`: a component whose server HTML is complete on its own (the
  // compiler's `client` list is empty: no state, handlers, hooks or values computed in the
  // browser, in it or the components it uses) gets no module. For pages that never change
  // those components' props from script.
  const shipped = (names) => (clientModules === 'needed' ? names.filter((name) => (describe(name).client ?? ['unknown']).length > 0) : names);
  const scripts = (all, async = false) => {
    const names = shipped(all);
    return names.length ? `<script type="module"${async ? ' async' : ''}>${names.map((name) => `import '${base}/components/${name}.js';`).join(' ')}</script>` : '';
  };

  /** What a request for `pathname` gets: `{ status, type, body }`, or null if it isn't ours. */
  function serve(pathname) {
    if (!pathname.startsWith(`${base}/`)) return null;
    const rest = decodeURIComponent(pathname.slice(base.length + 1));
    if (rest.startsWith('components/') && rest.endsWith('.js')) {
      const name = rest.slice('components/'.length, -3);
      // A plain module a component imports (`./theme.js`): the host serves it from the
      // components folder, as it is.
      if (!files.has(name)) return localModule(rest.slice('components/'.length)) ?? { status: 404, type: 'text/plain', body: 'Not found' };
      return { status: 200, type: TYPES['.js'], body: js(name) };
    }
    // The runtime and @zubra/sync are the host's to serve (from disk on Node, from static assets elsewhere).
    return assets(rest);
  }
  const cacheControl = cache ? 'public, max-age=3600' : 'no-cache';

  /** Fetch-style servers: a Response for our paths, or null. */
  async function fetchHandler(request) {
    const served = serve(new URL(request.url).pathname);
    if (!served) return null;
    return new Response(served.body, { status: served.status, headers: { 'content-type': served.type, 'cache-control': cacheControl } });
  }

  /** One page: render components into it, then `finish()` it (or use `head()` and `scripts()`). */
  function page() {
    const used = [];
    let renders = 0;
    const provided = {};
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
      /**
       * Provide a context's value to every component this page renders from now on, as a
       * component above them would: `page.provide({ module: './theme.js', export: 'theme' },
       * 'dark')`, where `module` is the file that exports `createContext()`, relative to the
       * components folder. Components render with it, and their elements start from it. To
       * change it in the browser, put the page in a `<zb-context>` with the same value.
       */
      provide(context, value) {
        if (!context || typeof context.module !== 'string' || typeof context.export !== 'string') {
          throw new Error("@zubra/server: page.provide() takes { module: './theme.js', export: 'theme' } and a value");
        }
        provided[contextKey(context)] = value;
        return this;
      },
      render(name, props = {}, slots) {
        const key = nameOf(name) ?? name;
        use(key);
        renders += 1;
        const idPrefix = renders === 1 ? '' : `r${renders}-`;
        const promises = Object.entries(props).filter(([, value]) => value && typeof value.then === 'function');
        if (!promises.length) return render(key, props, slots, [], idPrefix, provided);
        const given = Object.fromEntries(Object.entries(props).filter(([, value]) => !(value && typeof value.then === 'function')));
        const names = promises.map(([name]) => name);
        const id = String(streamed++);
        const shell = withStreamId(render(key, given, slots, names, idPrefix, provided), id);
        const entry = { key, id, given, slots, promises: new Map(promises), shell, count: 0, idPrefix };
        // Each pending region is a named range (`<?start name>`…`<?end>`) that a streamed
        // `<template for>` replaces (out-of-order streaming).
        entry.names = pendingRegions(shell).map(() => `zb-${id}-${entry.count++}`);
        pendingRenders.push(entry);
        // Until the values arrive, the element (should it start first) holds a promise for
        // each, set before it upgrades, so its `zb-await` shows the pending content.
        return `${named(shell, entry.names)}<script>(${HOLD_IN_BROWSER})(${JSON.stringify(id)},${JSON.stringify(names)})</script>`;
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
       * `streamResponse(html)` is a web `Response`; `chunks(html)` the strings it is made of
       * (Node's `stream(html)` turns them into a Readable).
       */
      chunks,
      streamResponse(html, init = {}) {
        return new Response(webStream(chunks(html)), { ...init, headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers } });
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
        const resolved = withStreamId(render(entry.key, entry.given, entry.slots, [...entry.promises.keys()], entry.idPrefix, provided), entry.id);
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

  // `hosts` counts the hosts given content so far, for their id prefixes; a stream shares one
  // across its chunks.
  function injectShadowRoots(html, { forms = true, lightDom = false, hosts = { count: 0 } } = {}) {
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
        // Each host is its own render: its own prefix keeps their ids apart.
        rendered = render(name, props, {}, [], `h${++hosts.count}-`);
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


  return {
    files,
    pathOf,
    serve,
    cacheControl,
    shadowHosts,
    injectShadowRoots,
    page,
    importMap,
    fetch: fetchHandler,
    module: (name) => js(nameOf(name) ?? name),
    names: [...files.keys()],
    describe: (name) => describe(nameOf(name) ?? name),
    render: (name, props, slots) => render(nameOf(name) ?? name, props, slots),
    head: (names = [...files.keys()]) => head(names),
    scripts: (names = [...files.keys()]) => scripts(names),
  };
}

/** An async iterable of strings as a web ReadableStream of UTF-8 bytes. */
function webStream(chunks) {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
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
  const script = `<script>(${SWAP_IN_BROWSER})(${JSON.stringify(id)},${JSON.stringify(values)})</script>`;
  return `${templates}${script}\n`;
}

// The two scripts below run in the browser, inlined into the page. They are kept as text, not as
// functions stringified with toString(): a bundler rewrites a function's body for the server it
// builds (esbuild's keep-names, which Wrangler turns on, wraps `var kind = function…` in a
// `__name()` helper that exists only in the bundle), and the page would then throw.
//
// Runs in the browser, inlined, right after a streamed host: a promise per pending prop, as a
// property the element captures when it upgrades, resolved by the swap script later.
const HOLD_IN_BROWSER = String.raw`function (id, names) {
  var host = document.querySelector('[data-zb-stream="' + id + '"]');
  var held = (window.__zubraStream = window.__zubraStream || {});
  for (var i = 0; i < names.length; i++) {
    (function (name) {
      host[name] = new Promise(function (resolve, reject) { held[id + ':' + name] = { resolve: resolve, reject: reject }; });
    })(names[i]);
  }
}`;

// Runs in the browser, inlined: hand the element the values (as properties, captured when it
// upgrades), and, before it starts, put the resolved regions in place where the browser didn't:
// browsers without out-of-order streaming leave each `<template for>` as an element, and those
// with it don't reach into a shadow root. Once the element has started it renders the regions
// itself (it removed their names, so the browser has nothing to replace).
const SWAP_IN_BROWSER = String.raw`function (id, values) {
  var host = document.querySelector('[data-zb-stream="' + id + '"]');
  var script = document.currentScript;
  var templates = [];
  for (var node = script && script.previousElementSibling; node && node.tagName === 'TEMPLATE' && node.hasAttribute('for'); node = node.previousElementSibling) templates.push(node);
  // A <?start name> or <?end>: a processing instruction, or the comment it parses as.
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
}`;

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

/** `module` (`./x.js`, `../x.js`) joined to the folder `base`, with `.` and `..` resolved, as the
 * compiler joins a component's import to its path. */
export function joinPath(base, module) {
  if (!module.startsWith('./') && !module.startsWith('../')) return module;
  const parts = base ? base.split('/') : [];
  for (const part of module.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}
