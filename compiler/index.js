// @mnx/compiler: the mnx compiler as WebAssembly, for Node (and bundler plugins) without a
// Rust toolchain. Same compiler, same output, same errors as the `mnix` CLI.
//
//   import { compileFile } from '@mnx/compiler';
//   const { ok, output, error, warnings } = compileFile('src/inbox.mnx', { emit: 'js' });
//
// `request()` is the raw interface: one JSON-shaped request in, one response out (see the
// compiler's `request` module). `compileFile()` reads the file and every `.mnx` file it
// imports, and makes that request.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const wasmUrl = new URL('./mnx.wasm', import.meta.url);
let exports = null;

/** Whether the WebAssembly module is present (it's built by `npm run build`, or ships in the package). */
export function available() {
  return existsSync(wasmUrl);
}

function wasm() {
  if (!exports) {
    if (!available()) throw new Error('@mnx/compiler: mnx.wasm is missing; run `npm run build` in its package (needs Rust with the wasm32-unknown-unknown target)');
    exports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasmUrl)), {}).exports;
  }
  return exports;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One request to the compiler; returns `{ ok, output, error, warnings, diagnostics }`. */
export function request(body) {
  const { memory, mnx_alloc, mnx_request, mnx_free } = wasm();
  const bytes = encoder.encode(JSON.stringify(body));
  const pointer = mnx_alloc(bytes.length);
  new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
  const packed = BigInt.asUintN(64, mnx_request(pointer, bytes.length));
  const at = Number(packed >> 32n);
  const length = Number(packed & 0xffffffffn);
  // The memory may have grown during the request; read through the current buffer.
  const text = decoder.decode(new Uint8Array(memory.buffer, at, length).slice());
  mnx_free(at, length);
  return JSON.parse(text);
}

/** The `.mnx` files `path` imports, recursively, with their sources (the path itself included). */
export function sources(path, files = {}) {
  const absolute = resolve(path);
  if (absolute in files) return files;
  let source;
  try { source = readFileSync(absolute, 'utf8'); } catch { return files; }
  files[absolute] = source;
  const script = source.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  for (const [, specifier] of script.matchAll(/import\s+(?:[^'"]*?from\s+)?['"]([^'"]+\.mnx)['"]/g)) {
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
