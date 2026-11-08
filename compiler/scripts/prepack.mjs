// Before `npm pack` / `npm publish`: refuse without zubra.wasm (the package would be broken), and
// copy the component registry in, without its tests. A script file rather than `node -e`, because
// npm runs scripts through cmd.exe on Windows, which mangled the one-liner's filter.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(here, 'zubra.wasm'))) {
  throw new Error('zubra.wasm is missing: run `npm run build` first (it needs the wasm32-unknown-unknown Rust target)');
}
const registry = join(here, 'registry');
rmSync(registry, { recursive: true, force: true });
const source = join(here, '../registry');
const skip = new Set(['test', 'node_modules']);
cpSync(source, registry, {
  recursive: true,
  // Judged by the path inside the registry, so a checkout under a folder named `test` still works.
  filter: (path) => !relative(source, path).split(/[\\/]/).some((part) => skip.has(part)),
});
