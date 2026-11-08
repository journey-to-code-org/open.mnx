// Which compiler @zubra/compiler uses. Installed from npm it carries its WebAssembly build. Inside
// the zubra repository that build may not exist (it needs Rust's wasm target), so the CLI that
// `cargo build` makes stands in, through ZUBRA_COMPILER.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = process.platform === 'win32' ? '.exe' : '';

/** `{ kind, path }` of the compiler to use, or null; sets ZUBRA_COMPILER for a native CLI. */
export function findCompiler() {
  const wasm = new URL('./zubra.wasm', import.meta.resolve('@zubra/compiler'));
  if (existsSync(fileURLToPath(wasm))) return { kind: 'WebAssembly', path: fileURLToPath(wasm) };
  if (process.env.ZUBRA_COMPILER && existsSync(process.env.ZUBRA_COMPILER)) return { kind: 'CLI', path: process.env.ZUBRA_COMPILER };
  // A checkout of the repository: target/{debug,release}/zubra above here or above the app.
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    let dir = start;
    for (let up = 0; up < 8; up++, dir = dirname(dir)) {
      for (const profile of ['debug', 'release']) {
        const cli = join(dir, 'target', profile, `zubra${exe}`);
        if (existsSync(cli)) {
          process.env.ZUBRA_COMPILER = cli;
          return { kind: 'CLI', path: cli };
        }
      }
    }
  }
  return null;
}
