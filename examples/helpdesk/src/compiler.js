// Which mnx compiler the server uses. Installed from npm, @mnx/compiler carries its WebAssembly
// build and that's all there is to it. Inside this repository that build may not exist (it needs
// Rust's wasm target), so the CLI that `cargo build` makes stands in, through MNX_COMPILER.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { available } from '@mnx/compiler';

export const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const exe = process.platform === 'win32' ? '.exe' : '';
export const CLI_CANDIDATES = ['debug', 'release'].map((profile) => join(repo, 'target', profile, `mnx${exe}`));

/** `{ kind, path }` of the compiler to use, or null if there's none yet. */
export function findCompiler() {
  if (available()) return { kind: 'WebAssembly', path: fileURLToPath(new URL('./mnx.wasm', import.meta.resolve('@mnx/compiler'))) };
  if (process.env.MNX_COMPILER && existsSync(process.env.MNX_COMPILER)) return { kind: 'CLI', path: process.env.MNX_COMPILER };
  const cli = CLI_CANDIDATES.find((path) => existsSync(path));
  return cli ? { kind: 'CLI', path: cli } : null;
}

/** Point @mnx/compiler at the compiler found (it reads MNX_COMPILER when mnx.wasm is missing). */
export function useCompiler() {
  const found = findCompiler();
  if (found?.kind === 'CLI') process.env.MNX_COMPILER = found.path;
  return found;
}

export const HOW_TO = `The help desk renders its components on the server, so it needs the mnx compiler. Either:
  - install Rust (https://rustup.rs) and run \`cargo build\` at the repository root
    (\`npm start\` does that for you when cargo is installed), or
  - put mnx.wasm in compiler/: download the "mnx-wasm" artifact from the latest CI run
    (GitHub → Actions → CI → a run on main → Artifacts), or build it with \`npm run build\` in compiler/.
Installed from npm, @mnx/compiler includes it.`;
