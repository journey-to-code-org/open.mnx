// How the language server reaches the compiler: the WebAssembly build (@zubra/compiler) when it's
// installed, otherwise the `zubra` CLI (or the one in `compiler`). Both give the same diagnostics.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export async function createBackend({ compiler } = {}) {
  if (!compiler) {
    try {
      const wasm = await import('@zubra/compiler');
      if (wasm.available()) return wasmBackend(wasm);
    } catch {
      // Not installed.
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
