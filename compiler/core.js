// @zubra/compiler/wasm: the compiler without a host. Nothing here reads a file, spawns a process
// or looks at `import.meta`, so it runs wherever WebAssembly does: Cloudflare Workers, Deno, a
// browser, Node. The caller hands it the compiler's WebAssembly module and the sources:
//
//   import wasm from '@zubra/compiler/zubra.wasm';      // a bundler gives a Worker a compiled module
//   import { createCompiler } from '@zubra/compiler/wasm';
//   const zubra = createCompiler(wasm);
//   const { html, css } = zubra.render('/app/inbox.zb', { files: { '/app/inbox.zb': source } });
//
// `index.js` is this file plus the parts that need Node (reading zubra.wasm and the sources from
// disk), so there is one implementation of the request glue and of `render`.

/**
 * The text of the hydration-marker comments a 4.x server writes (`<!--[-->`, `<!--]-->`, `<!---->`,
 * `<!--[?-->`, `<!--[!-->`), for tools that remove comments: keep the ones matching this. For example
 * html-minifier-terser's `ignoreCustomComments: [ZUBRA_MARKER_COMMENT]`. Since 5.0 the markers are
 * processing instructions (`<?zb [?>`), which minifiers keep without it.
 */
export const ZUBRA_MARKER_COMMENT = /^[[\]?!]*$/;

/**
 * For minifiers that strip the processing-instruction markers (`<?zb [?>`) unless told otherwise.
 * Most keep them as shipped (html-minifier-terser, @minify-html/node); these two need one option,
 * measured in server/test/markers.test.js:
 * - @swc/html: `minify(html, { preserveComments: [ZUBRA_MARKER_PATTERN] })`;
 * - htmlnano (and any posthtml pipeline): the parser option `{ directives: [ZUBRA_MARKER_DIRECTIVE] }`,
 *   htmlnano's fourth argument.
 */
export const ZUBRA_MARKER_PATTERN = '^\\?zb';
export const ZUBRA_MARKER_DIRECTIVE = Object.freeze({ name: '?zb', start: '<', end: '>' });

/** A compile error, with the rendered message and the diagnostics. */
export class CompileError extends Error {
  constructor(response) {
    super(response.error);
    this.name = 'CompileError';
    this.diagnostics = response.diagnostics;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One request to an instantiated compiler's exports: JSON in, the parsed JSON response out. */
export function requestWith(exports, body) {
  const { memory, zubra_alloc, zubra_request, zubra_free } = exports;
  const bytes = encoder.encode(JSON.stringify(body));
  const pointer = zubra_alloc(bytes.length);
  new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
  const packed = BigInt.asUintN(64, zubra_request(pointer, bytes.length));
  const at = Number(packed >> 32n);
  const length = Number(packed & 0xffffffffn);
  // The memory may have grown during the request; read through the current buffer.
  const text = decoder.decode(new Uint8Array(memory.buffer, at, length).slice());
  zubra_free(at, length);
  return JSON.parse(text);
}

/**
 * `render` and `format` over any `request` function. Paths are used as given: a caller with a file
 * system (index.js) resolves them first, and one without names its sources itself.
 */
export function over(request) {
  /**
   * Server-render the component at `path`: its HTML (which the element hydrates in the browser)
   * and the scoped stylesheets of it and the components it uses. `files` supplies every source
   * the render needs, by the path it is imported under (the component itself included); `props`
   * are the host's values (JSON), `slots` the supplied content by slot name (`default` for
   * unnamed content): HTML, kept as written (`slotSource: 'template'` reads it as zubra template
   * syntax instead). What only the browser can compute (JavaScript expressions, runtime-only
   * values) is left for the element to fill in when it starts; `partial: false` makes that an
   * error instead. Throws a `CompileError` on errors.
   */
  function render(path, { props = {}, slots = {}, slotSource = 'html', partial = true, files } = {}) {
    if (!files) {
      throw new Error(`@zubra/compiler: render('${path}') needs \`files\`: the component's source under that path, and the sources of the components it imports`);
    }
    const html = request({ emit: 'html', path, files, props, slots, slotSource, partial });
    if (!html.ok) throw new CompileError(html);
    const css = request({ emit: 'css', path, files });
    if (!css.ok) throw new CompileError(css);
    return { html: html.output, css: css.output, warnings: html.warnings };
  }

  /** The component's server-rendered HTML (see `render`). */
  function renderToString(path, options) {
    return render(path, options).html;
  }

  /**
   * `source` laid out the way `zubra fmt` lays it out: indentation and tags tidied, nothing it
   * compiles to changed (see the README's "Formatting"). `path` only names the file in errors.
   * Throws a CompileError when the source doesn't parse, or is a JSX component.
   */
  function format(source, { indentWidth, useTabs, printWidth, path = 'component.zb' } = {}) {
    const response = request({ command: 'format', path, files: { [path]: source }, indentWidth, useTabs, printWidth });
    if (!response.ok) throw new CompileError(response);
    return response.output;
  }

  return { request, render, renderToString, format };
}

/**
 * A compiler over the WebAssembly module you give it: a `WebAssembly.Module` (what a Worker's
 * bundler hands you for `import wasm from '…/zubra.wasm'`, or `await WebAssembly.compileStreaming(fetch(url))`
 * in a browser), or an instance or its exports. Returns `{ request, render, renderToString, format }`.
 */
export function createCompiler(wasm) {
  let exports;
  if (typeof WebAssembly !== 'undefined' && wasm instanceof WebAssembly.Module) exports = new WebAssembly.Instance(wasm, {}).exports;
  else if (typeof WebAssembly !== 'undefined' && wasm instanceof WebAssembly.Instance) exports = wasm.exports;
  else exports = wasm;
  if (!exports || typeof exports.zubra_request !== 'function') {
    throw new TypeError("@zubra/compiler: createCompiler() needs the compiler's WebAssembly module (zubra.wasm), compiled: a WebAssembly.Module, or an instance of it");
  }
  return over((body) => requestWith(exports, body));
}
