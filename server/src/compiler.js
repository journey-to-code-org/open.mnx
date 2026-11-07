// Which compiler @mnx/compiler uses. Installed from npm it carries its WebAssembly build. Inside
// the mnx repository that build may not exist (it needs Rust's wasm target), so the CLI that
// `cargo build` makes stands in, through MNX_COMPILER.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = process.platform === 'win32' ? '.exe' : '';

/** `{ kind, path }` of the compiler to use, or null; sets MNX_COMPILER for a native CLI. */
export function findCompiler() {
  const wasm = new URL('./mnx.wasm', import.meta.resolve('@mnx/compiler'));
  if (existsSync(fileURLToPath(wasm))) return { kind: 'WebAssembly', path: fileURLToPath(wasm) };
  if (process.env.MNX_COMPILER && existsSync(process.env.MNX_COMPILER)) return { kind: 'CLI', path: process.env.MNX_COMPILER };
  // A checkout of the repository: target/{debug,release}/mnx above here or above the app.
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    let dir = start;
    for (let up = 0; up < 8; up++, dir = dirname(dir)) {
      for (const profile of ['debug', 'release']) {
        const cli = join(dir, 'target', profile, `mnx${exe}`);
        if (existsSync(cli)) {
          process.env.MNX_COMPILER = cli;
          return { kind: 'CLI', path: cli };
        }
      }
    }
  }
  return null;
}
