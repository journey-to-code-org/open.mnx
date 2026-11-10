// How the language server reaches the compiler: the WebAssembly build (@zubra/compiler) when it's
// installed in the workspace (or beside the server), otherwise the `zubra` CLI (or the one in `compiler`). Both give the same diagnostics,
// and both format (`format` answers { ok, output } or { ok: false, error }).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Where @zubra/compiler is installed for a workspace: the nearest node_modules above `root` that has it.
 * The server can't rely on its own location for this: in the VS Code extension it sits inside the
 * extension's folder, and the compiler is in the project being edited.
 */
export function compilerEntries(root) {
  const found = [];
  for (let dir = root && resolve(root); dir; dir = dirname(dir) === dir ? null : dirname(dir)) {
    const entry = join(dir, 'node_modules/@zubra/compiler/index.js');
    if (existsSync(entry)) found.push(entry);
  }
  return found;
}

export async function createBackend({ compiler, root } = {}) {
  if (!compiler) {
    for (const specifier of [...compilerEntries(root).map((entry) => pathToFileURL(entry).href), '@zubra/compiler']) {
      try {
        const wasm = await import(specifier);
        if (wasm.available()) return wasmBackend(wasm);
      } catch {
        // Not installed there, or its WebAssembly isn't built.
      }
    }
  }
  const chosen = compiler ?? process.env.ZUBRA_COMPILER;
  if (chosen) return cliBackend(chosen);
  return cliBackend('zubra');
}

function wasmBackend(wasm) {
  return {
    name: 'wasm',
    check(path, text) {
      const files = wasm.sources(path);
      files[resolve(path)] = text;
      // Imports of the unsaved text, too.
      for (const specifier of importsOf(text)) wasm.sources(resolve(dirname(path), specifier), files);
      return wasm.request({ command: 'check', path: resolve(path), files }).diagnostics;
    },
    manifest(path) {
      const response = wasm.compileFile(path, { emit: 'manifest' });
      return response.ok ? JSON.parse(response.output) : null;
    },
    format(path, text, options) {
      const absolute = resolve(path);
      const response = wasm.request({ command: 'format', path: absolute, files: { [absolute]: text }, ...options });
      return response.ok ? { ok: true, output: response.output } : { ok: false, error: response.error ?? '' };
    },
  };
}

function cliBackend(compiler) {
  const run = (args, input) => spawnSync(compiler, args, { encoding: 'utf8', input });
  return {
    name: 'cli',
    check(path, text) {
      const result = run(['check', path, '--stdin', '--format', 'json'], text);
      if (result.error) return [{ file: path, line: 1, column: 1, severity: 'error', message: `zubra: couldn't run the compiler \`${compiler}\` (${result.error.code ?? result.error.message}); install @zubra/compiler or the zubra CLI`, help: null }];
      try { return JSON.parse(result.stdout); } catch { return []; }
    },
    manifest(path) {
      const result = run(['compile', path, '--emit', 'manifest']);
      if (result.status !== 0) return null;
      try { return JSON.parse(result.stdout); } catch { return null; }
    },
    format(path, text, { indentWidth, useTabs, printWidth } = {}) {
      const args = ['fmt', '--stdin', path];
      if (useTabs) args.push('--tabs');
      else if (indentWidth) args.push('--indent', String(indentWidth));
      if (printWidth) args.push('--width', String(printWidth));
      const result = run(args, text);
      if (result.error) return { ok: false, error: result.error.message };
      return result.status === 0 ? { ok: true, output: result.stdout } : { ok: false, error: result.stderr };
    },
  };
}

/** `.zb` files a component's script imports (relative specifiers). */
export function importsOf(text) {
  const script = text.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
  return [...script.matchAll(/import\s+(?:[^'"]*?from\s+)?['"](\.{1,2}\/[^'"]+\.zb)['"]/g)].map((match) => match[1]);
}

export const readText = (path) => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};
