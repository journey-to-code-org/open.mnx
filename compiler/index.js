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
import { dirname, join, posix, resolve } from 'node:path';
import { CompileError, CompilerCrash, over, restarting, ZUBRA_MARKER_COMMENT, ZUBRA_MARKER_DIRECTIVE, ZUBRA_MARKER_PATTERN } from './core.js';

// For Workers, Deno and browsers, which have no disk to read zubra.wasm from: `@zubra/compiler/wasm`.
export { CompileError, CompilerCrash, ZUBRA_MARKER_COMMENT, ZUBRA_MARKER_DIRECTIVE, ZUBRA_MARKER_PATTERN };

const wasmUrl = new URL('./zubra.wasm', import.meta.url);
let module = null;

/** Whether the WebAssembly module is present (it's built by `npm run build`, or ships in the package). */
export function available() {
  return existsSync(wasmUrl);
}

// One instance for the process, replaced if a request traps (a `CompilerCrash` for that request):
// a long-lived server or dev server must not lose its compiler to one bad input.
const wasm = restarting(() => {
  if (!module) {
    if (!available()) throw new Error('@zubra/compiler: zubra.wasm is missing; run `npm run build` in its package (needs Rust with the wasm32-unknown-unknown target)');
    module = new WebAssembly.Module(readFileSync(wasmUrl));
  }
  return new WebAssembly.Instance(module, {}).exports;
});

/**
 * One request to the compiler; returns `{ ok, output, error, warnings, diagnostics }`. Without
 * zubra.wasm, a native `zubra` named by $ZUBRA_COMPILER answers it instead (`zubra request`).
 */
export function request(body) {
  if (!available() && process.env.ZUBRA_COMPILER) return native(process.env.ZUBRA_COMPILER, body);
  return wasm(body);
}

function native(compiler, body) {
  const result = spawnSync(compiler, ['request'], { input: JSON.stringify(body), encoding: 'utf8', maxBuffer: 1 << 30 });
  if (result.error || result.status !== 0) throw new Error(`@zubra/compiler: ${compiler} request failed: ${result.error?.message ?? result.stderr}`);
  return JSON.parse(result.stdout);
}

/** The components (`.zb`, `.zb.jsx`, `.zb.tsx`) `path` imports, recursively, with their sources (the path itself included). */
export function sources(path, files = {}, key = resolve(path)) {
  const absolute = resolve(path);
  if (key in files) return files;
  let source;
  try { source = readFileSync(absolute, 'utf8'); } catch { return files; }
  files[key] = source;
  // A JSX component's imports are the whole file's; an .zb file's are its <script>'s.
  const script = /\.[jt]sx$/.test(absolute) ? source : source.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  for (const [, specifier] of script.matchAll(/import\s+(?:[^'"]*?from\s+)?['"]([^'"]+\.zb(?:\.[jt]sx)?)['"]/g)) {
    // A relative import is keyed like its importer: by path, or under the package specifier.
    if (specifier.startsWith('.')) sources(resolve(dirname(absolute), specifier), files, key.startsWith('/') ? resolve(dirname(absolute), specifier) : posix.join(posix.dirname(key), specifier));
    else {
      // A package's component, keyed by its specifier; its own relative imports are keyed under it.
      const found = packageFile(dirname(absolute), specifier);
      if (found.path) sources(found.path, files, posix.normalize(specifier));
    }
  }
  return files;
}

/**
 * Where a package's component (`@acme/kit/components/cart-panel.zb`) is, looked for as Node looks
 * for a package: in the node_modules of `dir` and each folder above it. A package with `exports`
 * must export the path (`"./components/*": "./components/*"`); one without exposes every file.
 * Returns `{ path }`, or `{ error }` saying why not.
 */
export function packageFile(dir, specifier) {
  const parts = specifier.split('/');
  const scoped = specifier.startsWith('@') ? 2 : 1;
  if (parts.length <= scoped) return { error: `\`${specifier}\` names a package, not a component in it` };
  const name = parts.slice(0, scoped).join('/');
  const subpath = `./${parts.slice(scoped).join('/')}`;
  for (let at = resolve(dir); ; at = dirname(at)) {
    const root = join(at, 'node_modules', name);
    if (existsSync(join(root, 'package.json')) || existsSync(root)) {
      let manifest = {};
      try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch {}
      const target = manifest.exports === undefined ? subpath : exported(manifest.exports, subpath);
      if (!target) return { error: `${name} doesn't export ${subpath} (its package.json "exports")` };
      const path = join(root, target);
      return existsSync(path) ? { path } : { error: `${name} has no ${target.replace(/^\.\//, '')}` };
    }
    if (dirname(at) === at) return { error: `${name} isn't installed: it isn't in any node_modules above ${dir}` };
  }
}

/** The file `exports` maps `subpath` to: an exact key, or one with a `*`; a string, or the first condition an import meets. */
function exported(exports, subpath) {
  const map = exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.')) ? exports : { '.': exports };
  // A condition object is read in its own order, taking the first condition an import meets.
  const pick = (value) =>
    typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(pick).find(Boolean) ?? null
    : value && typeof value === 'object' ? pick(Object.entries(value).find(([condition]) => ['import', 'node', 'default'].includes(condition))?.[1])
    : null;
  if (subpath in map) return pick(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star < 0 || subpath.length < key.length - 1 || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1))) continue;
    const matched = subpath.slice(star, subpath.length - (key.length - star - 1));
    return pick(value)?.replaceAll('*', matched) ?? null;
  }
  return null;
}

/**
 * Compile the component at `path`. Options mirror the CLI's: `emit` (`html` | `js` | `css` |
 * `dts` | `manifest`), `command: 'check'`, `runtime`, `keepImports`, `devtools`, `noImports`, `cssImport` +
 * `cssImportInline`, `framework`, `modulePath`, `props`, `slots`.
 */
export function compileFile(path, options = {}) {
  const absolute = resolve(path);
  return request({ ...options, path: absolute, files: sources(absolute) });
}

const compiler = over(request);

/**
 * `source` laid out the way `zubra fmt` lays it out: indentation and tags tidied, nothing it
 * compiles to changed (see the README's "Formatting"). `path` only names the file in errors.
 * Throws a CompileError when the source doesn't parse, or is a JSX component.
 */
export function format(source, { path = 'component.zb', ...options } = {}) {
  return compiler.format(source, { ...options, path: resolve(path) });
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
export function render(path, options = {}) {
  const absolute = resolve(path);
  return compiler.render(absolute, { ...options, files: options.files ?? sources(absolute) });
}

/** The component's server-rendered HTML (see `render`). */
export function renderToString(path, options) {
  return render(path, options).html;
}
