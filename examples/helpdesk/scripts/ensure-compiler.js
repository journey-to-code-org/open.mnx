// Runs before `npm start` and `npm test`: make sure there's an mnx compiler, building the CLI
// with cargo if that's the way to get one. (Installed from npm, @mnx/compiler includes its
// WebAssembly build and none of this is needed.)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const HOW_TO = `The help desk renders its components on the server, so it needs the mnx compiler. Either:
  - install Rust (https://rustup.rs) and run \`cargo build\` at the repository root
    (\`npm start\` does that for you when cargo is installed), or
  - put mnx.wasm in compiler/: download the "mnx-wasm" artifact from the latest CI run
    (GitHub → Actions → CI → a run on main → Artifacts), or build it with \`npm run build\` in compiler/.
Installed from npm, @mnx/compiler includes it.`;

// (@mnx/server finds it: mnx.wasm, MNX_COMPILER, or this repository's target/ folder.)
const { findCompiler } = await import('@mnx/server');
const find = async () => findCompiler(); // (it looks again each time)
let found = await find().catch(() => null);
if (!found) {
  const cargo = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (cargo.status === 0) {
    console.log('mnx: building the compiler once (cargo build at the repository root)…');
    const build = spawnSync('cargo', ['build'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
    if (build.status === 0) found = await find().catch(() => null);
  }
}
if (!found) {
  console.error(`\nmnx: no compiler found.\n${HOW_TO}\n`);
  process.exit(1);
}
console.log(`mnx: using the ${found.kind} compiler (${found.path})`);
