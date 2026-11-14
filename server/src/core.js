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

// The renders kept for asking again (see `answer` in `createCore`): how many, how many characters
// of keys and HTML in all, and the largest one answer may be.
const RENDERS = 500;
const RENDER_BYTES = 8 * 1024 * 1024;
const RENDER_LARGEST = 512 * 1024;

/**
 * `request(body)`: the compiler (`{ ok, output, error }`). `files`: a Map from component name
 * (the path without its extension, "/"-separated) to the path its source is known by.
 * `sourcesOf(path)`: that component's source and the sources of the components it imports, by
 * path. `where`: how an error names the place the components came from. `assets(rest)`: what the
 * host serves under `<base>/` beyond the components' modules (`{ status, type, body }` or null).
 * `needs(name, code)`: the host's check on a compiled module (a package it needs being installed).
 */
export function createCore({ request, files, fromPackage = () => false, sourcesOf: readSources, cache = true, devtools = false, base, imports = {}, syncImports = {}, needs = (_name, code) => code, where = 'the components', assets = () => null, warn = (message) => console.warn(message), gaps = 'warn', clientModules = 'all', inline = true, preload = true, runtimeModules = {}, localModule = () => null, contextKey = ({ module, export: name }) => `${joinPath('', module)}#${name}` }) {
  if (gaps !== 'warn' && gaps !== 'ignore') throw new Error(`@zubra/server: gaps is "warn" or "ignore", not ${JSON.stringify(gaps)}`);
  if (clientModules !== 'all' && clientModules !== 'needed') throw new Error(`@zubra/server: clientModules is "all" or "needed", not ${JSON.stringify(clientModules)}`);
  if (typeof inline !== 'boolean') throw new Error(`@zubra/server: inline is true or false, not ${JSON.stringify(inline)}`);
  if (typeof preload !== 'boolean') throw new Error(`@zubra/server: preload is true or false, not ${JSON.stringify(preload)}`);
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
  /** A component's own source, without its comments: two copies of one component compare equal. */
  const ownSource = (name) => {
    const path = pathOf(name);
    const sources = sourcesOf(path);
    return String(sources[path] ?? Object.values(sources)[0] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  };
  /**
   * Which component each tag is, and which package components the app's own stand in for. An
   * app's component and a package's with one tag (both carrying a copy of a shared part, say):
   * the app's wins everywhere, the package's own imports of it included, and if the two copies
   * differ the server says so. Two of the app's, or two packages', with one tag is an error.
   */
  const warned = new Set();
  const owners = () =>
    once('tags', () => {
      const tags = new Map();
      const shadows = new Map();
      // `files` lists the app's components before any package's, so the app's copy is kept.
      for (const name of files.keys()) {
        const { tag } = describe(name);
        const kept = tags.get(tag);
        if (kept === undefined) {
          tags.set(tag, name);
          continue;
        }
        if (fromPackage(kept) || !fromPackage(name)) throw new Error(`@zubra/server: <${tag}> is defined by both ${kept} and ${name}`);
        shadows.set(name, kept);
        // Once per server, even with `cache: false` (which works this out again for each render).
        const message = `@zubra/server: <${tag}> is the app's ${kept}, in place of ${name}, which differs from it: the package's components get the app's`;
        if (!warned.has(message) && ownSource(name) !== ownSource(kept)) {
          warned.add(message);
          warn(message);
        }
      }
      return { tags, shadows };
    });
  const byTag = () => owners().tags;
  /** A component name or tag as the component that answers for it (the app's, for a shadowed package one). */
  const nameOf = (nameOrTag) => (files.has(nameOrTag) ? (fromPackage(nameOrTag) ? owners().shadows.get(nameOrTag) ?? nameOrTag : nameOrTag) : byTag().get(nameOrTag));

  // `idPrefix`: renders that end up in one page number their hosts' ids apart (`id()`).
  // `context`: the values the page provides (`page.provide()`), by context key.
  // A component's HTML is a function of its sources and what it is rendered with, and nothing
  // else: the compiler evaluates only what is deterministic. So with `cache` (where the sources
  // are read once), a render asked for again with the same props, slots, context and id prefix
  // is answered from the last one: a page's navigation, its forms, a list that hasn't changed.
  // The most recently used are kept, within `RENDERS` entries and `RENDER_BYTES` characters; one
  // answer larger than `RENDER_LARGEST` isn't kept. A promise prop is never the same twice.
  const rendered = new Map();
  let renderedSize = 0;
  const answer = (name, props, slots, pending, idPrefix, context) => {
    const path = pathOf(name);
    const ask = () => request({ path, files: sourcesOf(path), emit: 'html', props, slots, slotSource: 'html', partial: true, ...(gaps === 'warn' ? { gaps: true } : {}), ...(pending.length ? { pending } : {}), ...(idPrefix ? { idPrefix } : {}), ...(Object.keys(context).length ? { context } : {}) });
    if (!cache || pending.length) return ask();
    // What the request would say, as it would say it (JSON), so two keys are equal exactly when
    // the two requests are.
    const key = `${path}\n${idPrefix}\n${JSON.stringify([props, slots, context])}`;
    const kept = rendered.get(key);
    if (kept !== undefined) {
      rendered.delete(key); // (moved to the end: the most recently used)
      rendered.set(key, kept);
      return kept;
    }
    const response = ask();
    const size = key.length + (response.ok ? response.output.length : 0);
    if (!response.ok || size > RENDER_LARGEST) return response;
    rendered.set(key, response);
    renderedSize += size;
    for (const [oldest, old] of rendered) {
      if (rendered.size <= RENDERS && renderedSize <= RENDER_BYTES) break;
      rendered.delete(oldest);
      renderedSize -= oldest.length + old.output.length;
    }
    return response;
  };
  const render = (name, props = {}, slots = {}, pending = [], idPrefix = '', context = {}) => {
    const response = answer(name, props, slots, pending, idPrefix, context);
    if (!response.ok) throw new Error(response.error);
    // A value that isn't a safe URL (a user's `javascript:` link) is left out, as the element
    // leaves it out in the browser; the page still renders, and this says what was dropped.
    for (const message of response.omitted ?? []) warn(`@zubra/server: <${name}>: ${message}`);
    // What the server couldn't compute and left for the browser (a list derived through `Intl`,
    // a formatted date): empty in the HTML, so without JavaScript, and until the module loads,
    // that part is missing. Said once per place, as `zubra check --server` says it.
    for (const gap of response.gaps ?? []) {
      const message = `@zubra/server: <${name}> leaves part of its HTML for the browser (empty without JavaScript). Compute it before rendering and pass it as a prop, or pass gaps: 'ignore' if that's intended.\n${gap}`;
      if (warned.has(message)) continue;
      warned.add(message);
      warn(message);
    }
    return response.output;
  };
  const css = (name) => once(`css:${name}`, () => call(pathOf(name), { emit: 'css' }));
  /**
   * The plain `.js` modules in the components folder that the browser imports: those a
   * component's browser module imports by relative path, and those they import in turn. Paths
   * relative to the folder. A module only a `'use server'` function imports isn't among them.
   */
  const browserModules = () => once('browser-modules', () => {
    const found = new Set();
    const queue = [];
    const add = (from, specifier) => {
      const path = joinPath(from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '', specifier);
      if (path.endsWith('.js') && !found.has(path)) {
        found.add(path);
        queue.push(path);
      }
    };
    for (const name of files.keys()) {
      let code;
      try {
        code = js(name);
      } catch {
        continue; // a component that doesn't compile imports nothing
      }
      for (const specifier of relativeImports(code)) add(name, specifier);
    }
    while (queue.length) {
      const path = queue.shift();
      const module = localModule(path);
      if (module) for (const specifier of relativeImports(String(module.body))) add(path, specifier);
    }
    return found;
  });
  const js = (name) => once(`js:${name}`, () => {
    const path = pathOf(name);
    const response = request({ emit: 'js', runtime: '@zubra/runtime', devtools, path, files: sourcesOf(path) });
    if (!response.ok) throw new Error(response.error);
    return resolved(needs(name, response.output));
  });

  /** What each bare specifier a browser module may import resolves to: the import map's entries. */
  const mapping = () => ({ '@zubra/runtime': `${base}/runtime/index.js`, '@zubra/runtime/spread': `${base}/runtime/spread.js`, '@zubra/runtime/primitives': `${base}/runtime/primitives.js`, '@zubra/runtime/motion': `${base}/runtime/motion.js`, '@zubra/runtime/track': `${base}/runtime/track.js`, ...syncImports, ...imports });
  /**
   * `inline: false` (a Content-Security-Policy without `'unsafe-inline'`, on a site that can't
   * give each response a nonce): a page gets no import map, so every module is served with its
   * bare imports already resolved, to what the import map would have said.
   */
  const resolved = (code) => (inline ? code : resolveImports(String(code), mapping()));
  const importMap = (options) => (inline ? `<script type="importmap"${nonceAttribute(options)}>${scriptJson({ imports: mapping() })}</script>` : '');
  /**
   * The modules under `base` that the module at `url` imports statically, as URLs. A module this
   * server can't read (`@zubra/sync`, where the host serves it from static assets) imports
   * nothing as far as it knows.
   */
  const importsOf = (url) => once(`imports:${url}`, () => {
    // The runtime's own modules: from its list (`@zubra/runtime/modules`), not from the files,
    // so a page is the same wherever it is built, a host that can't read them included.
    if (url.startsWith(`${base}/runtime/`)) return (runtimeModules[url.slice(`${base}/runtime/`.length)] ?? []).map((name) => `${base}/runtime/${name}`);
    const served = serve(url);
    if (!served || served.status !== 200) return [];
    const map = mapping();
    return staticImports(String(served.body))
      .map((specifier) => resolveSpecifier(specifier, url, map))
      // Ours, and there: text that only looks like an import (in a string) names nothing we serve.
      // (The runtime's modules aren't asked for: the host may serve them from somewhere else.)
      .filter((to) => to !== null && to.startsWith(`${base}/`) && (to.startsWith(`${base}/runtime/`) || (serve(to)?.status ?? 200) === 200));
  });
  /**
   * Every module the page's components load, each once, the components' own first: what they
   * import, and what those import. The browser otherwise finds each level by fetching and
   * parsing the one before (the component, the runtime's entry, the entry's modules, theirs),
   * a round trip per level; told up front, it fetches them all at once.
   */
  const moduleGraph = (names) => {
    const found = new Set(names.map((name) => `${base}/components/${name}.js`));
    for (const url of found) for (const to of importsOf(url)) found.add(to);
    return [...found];
  };
  const preloads = (names, options) => (preload ? moduleGraph(shipped(names)).map((url) => `<link rel="modulepreload" href="${escapeAttribute(url)}"${nonceAttribute(options)}>`).join('\n') : '');
  const head = (names, options) => {
    // A component that needs a package that isn't installed fails here, while the page is built,
    // with the reason, rather than later in the browser as an unresolved import.
    for (const name of names) js(name);
    const links = preloads(names, options);
    // Without inline elements: a stylesheet link per component that has CSS, and no import map.
    if (!inline) return [...names.filter((name) => css(name)).map((name) => `<link rel="stylesheet" href="${escapeAttribute(`${base}/components/${name}.css`)}" data-zb-components>`), ...(links ? [links] : [])].join('\n');
    const styles = names.map(css).join('\n');
    // The preload links come after the import map: a module fetched before it couldn't be one the map names.
    return `${styles ? `<style data-zb-components${nonceAttribute(options)}>${styles}</style>\n` : ''}${importMap(options)}${links ? `\n${links}` : ''}`;
  };
  // `clientModules: 'needed'`: a component whose server HTML is complete on its own (the
  // compiler's `client` list is empty: no state, handlers, hooks or values computed in the
  // browser, in it or the components it uses) gets no module. For pages that never change
  // those components' props from script.
  const shipped = (names) => (clientModules === 'needed' ? names.filter((name) => (describe(name).client ?? ['unknown']).length > 0) : names);
  const scripts = (all, async = false, options) => {
    const names = shipped(all);
    if (!inline) return names.map((name) => `<script type="module"${async ? ' async' : ''} src="${escapeAttribute(`${base}/components/${name}.js`)}"></script>`).join('');
    return names.length ? `<script type="module"${async ? ' async' : ''}${nonceAttribute(options)}>${names.map((name) => `import '${base}/components/${name}.js';`).join(' ')}</script>` : '';
  };

  /** What a request for `pathname` gets: `{ status, type, body }`, or null if it isn't ours. */
  function serve(pathname) {
    if (!pathname.startsWith(`${base}/`)) return null;
    let rest;
    // A malformed escape (`%E0%A4%A`) is the client's mistake: a 400, never a throw that
    // takes down a server written as `if (zubra.handle(req, res)) return;`.
    try { rest = decodeURIComponent(pathname.slice(base.length + 1)); } catch { return { status: 400, type: 'text/plain', body: 'Bad request' }; }
    // A component's stylesheet, for the `<link>` a page without inline elements has.
    if (!inline && rest.startsWith('components/') && rest.endsWith('.css')) {
      const name = rest.slice('components/'.length, -4);
      return files.has(name) ? { status: 200, type: TYPES['.css'], body: css(name) } : { status: 404, type: 'text/plain', body: 'Not found' };
    }
    if (rest.startsWith('components/') && rest.endsWith('.js')) {
      const name = rest.slice('components/'.length, -3);
      // A plain module a component imports (`./theme.js`): the host serves it from the
      // components folder, as it is.
      // Only one a browser module imports, though: the folder also holds what `'use server'`
      // functions import (keys, database code), and those stay on the server.
      if (!files.has(name)) {
        const path = rest.slice('components/'.length);
        const module = browserModules().has(path) && localModule(path);
        return module ? (inline ? module : { ...module, body: resolved(module.body) }) : { status: 404, type: 'text/plain', body: 'Not found' };
      }
      // A package's copy of a tag the app has too: the module is the app's, so the browser
      // defines the tag once, however the package's components import it.
      const app = fromPackage(name) ? owners().shadows.get(name) : undefined;
      if (app !== undefined) {
        const url = JSON.stringify(`${base}/components/${app}.js`);
        return { status: 200, type: TYPES['.js'], body: `export * from ${url};\nexport { default } from ${url};\n` };
      }
      return { status: 200, type: TYPES['.js'], body: js(name) };
    }
    // The runtime and @zubra/sync are the host's to serve (from disk on Node, from static assets elsewhere).
    const asset = assets(rest);
    // The runtime's and @zubra/sync's own modules import each other by name too.
    return asset && !inline && asset.status === 200 && rest.endsWith('.js') ? { ...asset, body: resolved(asset.body) } : asset;
  }
  const cacheControl = cache ? 'public, max-age=3600' : 'no-cache';

  /** Fetch-style servers: a Response for our paths, or null. */
  async function fetchHandler(request) {
    const served = serve(new URL(request.url).pathname);
    if (!served) return null;
    return new Response(served.body, { status: served.status, headers: { 'content-type': served.type, 'cache-control': cacheControl } });
  }

  /** One page: render components into it, then `finish()` it (or use `head()` and `scripts()`). */
  function page(options = {}) {
    nonceAttribute(options); // a nonce that can't be one fails here, not in the middle of a page
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
        // A promise prop is handed over by inline scripts, which a page can't do without.
        if (!inline && options.nonce === undefined) throw new Error('@zubra/server: with inline: false, a prop given as a promise needs a nonce for the scripts that stream its value: page({ nonce })');
        const id = String(streamed++);
        const shell = withStreamId(render(key, given, slots, names, idPrefix, provided), id);
        const entry = { key, id, given, slots, promises: new Map(promises), shell, count: 0, idPrefix };
        // Each pending region is a named range (`<?start name>`…`<?end>`) that a streamed
        // `<template for>` replaces (out-of-order streaming).
        entry.names = pendingRegions(shell).map(() => `zb-${id}-${entry.count++}`);
        pendingRenders.push(entry);
        // Until the values arrive, the element (should it start first) holds a promise for
        // each, set before it upgrades, so its `zb-await` shows the pending content.
        return `${named(shell, entry.names)}<script${nonceAttribute(options)}>(${HOLD_IN_BROWSER})(${scriptJson(id)},${scriptJson(names)})</script>`;
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
      head: () => head(used, options),
      /** The module script that makes the components interactive, for the end of `<body>`. */
      scripts: () => scripts(used, false, options),
      /** A whole page with the head and scripts put in (before `</head>` and `</body>`). */
      finish(html) {
        return insertBefore(insertBefore(html, '</head>', head(used, options)), '</body>', scripts(used, false, options));
      },
    };

    async function* chunks(html) {
      // The shell: as the ordinary page, but with the module script `async`, so the elements
      // start as soon as it has loaded instead of when the stream ends (a module script is
      // deferred until the document is complete). A region that arrives after an element has
      // started reaches it as a property change.
      yield insertBefore(insertBefore(html, '</head>', head(used, options)), '</body>', scripts(used, true, options));
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
          yield swapScript(entry.id, null, { [name]: { error } }, options);
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
        yield swapScript(entry.id, regions, { [name]: { value } }, options);
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
    css: (name) => css(nameOf(name) ?? name),
    resolveImports: (code) => resolved(code),
    head: (names = [...files.keys()], options) => head(names, options),
    scripts: (names = [...files.keys()], options) => scripts(names, false, options),
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

/**
 * JSON for inside an inline `<script>`: `<` is written `\u003c`, so no value can close the script
 * (`</script>`) or open a comment (`<!--`), and U+2028/U+2029 are escaped for older parsers.
 * The script reads the same values.
 */
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The chunk for one settled promise: each resolved region in a `<template for>`, and the script. */
function swapScript(id, regions, values, options) {
  const templates = (regions ?? []).map((region) => `<template for="${region.name}">${region.html}</template>`).join('');
  const script = `<script${nonceAttribute(options)}>(${SWAP_IN_BROWSER})(${scriptJson(id)},${scriptJson(values)})</script>`;
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

/** The relative specifiers (`./x.js`, `../x.js`) a module imports, statically or with `import()`. */
/**
 * ` nonce="…"` for an inline `<script>` or `<style>`, from `{ nonce }`: what a
 * Content-Security-Policy with `'nonce-…'` lets through. Base64 (or base64url) only, as the
 * policy's grammar has it, so it can't close the attribute.
 */
export function nonceAttribute(options) {
  const nonce = options?.nonce;
  if (nonce === undefined || nonce === null) return '';
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(nonce)) throw new Error('@zubra/server: nonce is the base64 value of the Content-Security-Policy\'s nonce (letters, digits, + / - _ and = padding)');
  return ` nonce="${nonce}"`;
}

/**
 * `code` with the bare specifiers its `import`s name resolved as an import map of `imports`
 * would: an exact entry, or the longest entry ending in "/" that the specifier starts with.
 * Relative paths, absolute paths and URLs are left alone, as is a specifier with no entry.
 */
export function resolveImports(code, imports) {
  const prefixes = Object.keys(imports).filter((key) => key.endsWith('/')).sort((a, b) => b.length - a.length);
  return code.replace(/(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\2/g, (whole, before, quote, specifier) => {
    if (/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return whole;
    if (Object.hasOwn(imports, specifier)) return `${before}${quote}${imports[specifier]}${quote}`;
    const prefix = prefixes.find((key) => specifier.startsWith(key));
    return prefix ? `${before}${quote}${imports[prefix]}${specifier.slice(prefix.length)}${quote}` : whole;
  });
}

/**
 * The specifiers of `code`'s static imports and re-exports (`import … from 'x'`, `import 'x'`,
 * `export … from 'x'`), minified or not. `import('x')` isn't among them: it loads when it runs.
 */
export function staticImports(code) {
  const found = [];
  const pattern = /(?:^|[^.\w$])(?:import|export)\s*(?:[\w$*{},\s]+?\bfrom\s*|[*{][^'"()]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g;
  for (const match of code.matchAll(pattern)) found.push(match[2]);
  return found;
}

/**
 * What `specifier`, imported by the module at the absolute path `from`, resolves to: a path
 * for a relative or absolute one, the import map's answer (`imports`) for a bare one, and null
 * for a URL with a scheme or a bare specifier the map doesn't have.
 */
export function resolveSpecifier(specifier, from, imports) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('//')) return null;
  if (specifier.startsWith('/')) return specifier;
  if (specifier.startsWith('./') || specifier.startsWith('../')) return joinPath(from.slice(0, from.lastIndexOf('/')), specifier);
  if (Object.hasOwn(imports, specifier)) return imports[specifier];
  const prefix = Object.keys(imports).filter((key) => key.endsWith('/')).sort((a, b) => b.length - a.length).find((key) => specifier.startsWith(key));
  return prefix ? `${imports[prefix]}${specifier.slice(prefix.length)}` : null;
}

export function relativeImports(code) {
  const found = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"\n]+)\1/g;
  for (const match of code.matchAll(pattern)) found.push(match[2]);
  return found;
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
