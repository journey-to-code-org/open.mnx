// @zubra/compiler: the zubra compiler as WebAssembly, for Node (and bundler plugins) without a
// Rust toolchain. Same compiler, same output, same errors as the `zubra` CLI.
//
//   import { compileFile, renderToString } from '@zubra/compiler';
//   const { ok, output, error, warnings } = compileFile('src/inbox.zb', { emit: 'js' });
//   const html = renderToString('src/inbox.zb', { props: { heading: 'Mail' } });
//
// `request()` is the raw interface: one JSON-shaped request in, one response out (see the
// compiler's `request` module). `compileFile()` reads the file and every `.zb` file it
// imports, and makes that request.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

const wasmUrl = new URL('./zubra.wasm', import.meta.url);
let exports = null;

/** Whether the WebAssembly module is present (it's built by `npm run build`, or ships in the package). */
export function available() {
  return existsSync(wasmUrl);
}

function wasm() {
  if (!exports) {
    if (!available()) throw new Error('@zubra/compiler: zubra.wasm is missing; run `npm run build` in its package (needs Rust with the wasm32-unknown-unknown target)');
    exports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasmUrl)), {}).exports;
  }
  return exports;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * One request to the compiler; returns `{ ok, output, error, warnings, diagnostics }`. Without
 * zubra.wasm, a native `zubra` named by $ZUBRA_COMPILER answers it instead (`zubra request`).
 */
export function request(body) {
  if (!available() && process.env.ZUBRA_COMPILER) return native(process.env.ZUBRA_COMPILER, body);
  const { memory, zubra_alloc, zubra_request, zubra_free } = wasm();
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

function native(compiler, body) {
  const result = spawnSync(compiler, ['request'], { input: JSON.stringify(body), encoding: 'utf8', maxBuffer: 1 << 30 });
  if (result.error || result.status !== 0) throw new Error(`@zubra/compiler: ${compiler} request failed: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout);
}

/** The components (`.zb`, `.zb.jsx`, `.zb.tsx`) `path` imports, recursively, with their sources (the path itself included). */
export function sources(path, files = {}) {
  const absolute = resolve(path);
  if (absolute in files) return files;
  let source;
  try { source = readFileSync(absolute, 'utf8'); } catch { return files; }
  files[absolute] = source;
  // A JSX component's imports are the whole file's; an .zb file's are its <script>'s.
  const script = /\.[jt]sx$/.test(absolute) ? source : source.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  for (const [, specifier] of script.matchAll(/import\s+(?:[^'"]*?from\s+)?['"]([^'"]+\.zb(?:\.[jt]sx)?)['"]/g)) {
    if (specifier.startsWith('.')) sources(resolve(dirname(absolute), specifier), files);
  }
  return files;
}

/**
 * Compile the component at `path`. Options mirror the CLI's: `emit` (`html` | `js` | `css` |
 * `dts` | `manifest`), `command: 'check'`, `runtime`, `keepImports`, `noImports`, `cssImport` +
 * `cssImportInline`, `framework`, `modulePath`, `props`, `slots`.
 */
export function compileFile(path, options = {}) {
  const absolute = resolve(path);
  return request({ ...options, path: absolute, files: sources(absolute) });
}

/** A compile error, with the rendered message and the diagnostics. */
export class CompileError extends Error {
  constructor(response) {
    super(response.error);
    this.name = 'CompileError';
    this.diagnostics = response.diagnostics;
  }
}

/**
 * Server-render the component at `path`: its HTML (which the element hydrates in the browser)
 * and the scoped stylesheets of it and the components it uses. `props` are the host's values
 * (JSON), `slots` the supplied content by slot name (`default` for unnamed content): HTML,
 * kept as written (`slotSource: 'template'` reads it as zubra template syntax instead). `files`
 * supplies the sources instead of reading them from disk (see `sources`). What only the browser
 * can compute (JavaScript expressions, runtime-only values) is left for the element to fill in
 * when it starts; `partial: false` makes that an error instead. Throws a `CompileError` on errors.
 */
export function render(path, { props = {}, slots = {}, slotSource = 'html', partial = true, files } = {}) {
  const absolute = resolve(path);
  const all = files ?? sources(absolute);
  const html = request({ emit: 'html', path: absolute, files: all, props, slots, slotSource, partial });
  if (!html.ok) throw new CompileError(html);
  const css = request({ emit: 'css', path: absolute, files: all });
  if (!css.ok) throw new CompileError(css);
  return { html: html.output, css: css.output, warnings: html.warnings };
}

/** The component's server-rendered HTML (see `render`). */
export function renderToString(path, options) {
  return render(path, options).html;
}
