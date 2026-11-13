// Typings for components, for the TypeScript plugin (typescript-plugin/), which runs inside
// tsserver and has to answer at once: it starts this with a list of components on stdin,
//
//   [{ "path": "/app/src/badge.zb", "framework": "react" }, …]
//
// and reads back, in the same order, `{ "text": "…" }` (what `zubra compile --emit dts` writes)
// or `{ "error": "…" }`. The compiler is found as the language server finds it: the project's
// @zubra/compiler (WebAssembly), else the CLI named by the plugin's `compiler` setting,
// ZUBRA_COMPILER, a cargo build in a zubra checkout, or `zubra` on PATH.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkoutCompiler, compilerEntries, resolveCommand } from './backend.js';

const { components, compiler } = JSON.parse(readFileSync(0, 'utf8'));

const loaded = new Map();
async function wasm(path) {
  const [entry] = compilerEntries(dirname(path));
  if (!entry) return null;
  if (!loaded.has(entry)) loaded.set(entry, await import(pathToFileURL(entry).href));
  const module = loaded.get(entry);
  return module.available?.() || process.env.ZUBRA_COMPILER ? module : null;
}

function cli(path) {
  return compiler || process.env.ZUBRA_COMPILER || checkoutCompiler(dirname(path)) || 'zubra';
}

const results = [];
for (const { path, framework } of components) {
  try {
    const module = compiler ? null : await wasm(path);
    if (module) {
      const response = module.compileFile(path, { emit: 'dts', framework });
      results.push(response.ok ? { text: response.output } : { error: response.error });
      continue;
    }
    const run = spawnSync(resolveCommand(cli(path)), ['compile', path, '--emit', 'dts', '--framework', framework], { encoding: 'utf8', maxBuffer: 1 << 28 });
    results.push(run.status === 0 ? { text: run.stdout } : { error: run.error?.message ?? run.stderr });
  } catch (error) {
    results.push({ error: error.message });
  }
}
process.stdout.write(JSON.stringify(results));
