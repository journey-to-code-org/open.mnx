// The server halves of a components folder: each component's 'use server' functions, compiled.
// Node only (reads the folder, runs the compiler); used when the Node entry starts and by
// `zubra-actions build`, so both see the same functions.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findCompiler } from '@zubra/server';

const SOURCE = /\.zb(?:\.[jt]sx)?$/;

let compiler;
async function load() {
  if (!compiler) {
    findCompiler();
    compiler = await import('@zubra/compiler');
  }
  return compiler;
}

/** `[{ path, output }]` for every component under `root` that has server functions, in path order. */
export async function serverHalves(root) {
  const { request, sources: read } = await load();
  const halves = [];
  for (const path of sources(resolve(root))) {
    const response = request({ emit: 'server', path, files: read(path) });
    if (!response.ok) throw new Error(response.error);
    if (/^export (async )?function /m.test(response.output)) halves.push({ path, output: response.output });
  }
  return halves;
}

/** A component's path without its extension, flattened into one file name: `forms/login.zb` → `forms__login`. */
export const flatName = (relativePath) => relativePath.split(/[\\/]/).join('__').replace(SOURCE, '');

/** Rewrite each relative import (`'./x'`, `'../x'`) with `to(specifier)`. */
export function rewriteImports(code, to) {
  return code.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, keyword, quote, specifier) => `${keyword}${quote}${to(specifier)}${quote}`);
}

function sources(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && !entry.startsWith('.')) sources(path, out);
    } else if (SOURCE.test(entry)) out.push(path);
  }
  return out;
}
