// Runs before `npm start` and `npm test`: make sure there's a zubra compiler, building the CLI
// with cargo if that's the way to get one. (Installed from npm, @zubra/compiler includes its
// WebAssembly build and none of this is needed.)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const HOW_TO = `The help desk renders its components on the server, so it needs the zubra compiler. Either:
  - install Rust (https://rustup.rs) and run \`cargo build\` at the repository root
    (\`npm start\` does that for you when cargo is installed), or
  - put zubra.wasm in compiler/: download the "zubra-wasm" artifact from the latest CI run
    (GitHub → Actions → CI → a run on main → Artifacts), or build it with \`npm run build\` in compiler/.
Installed from npm, @zubra/compiler includes it.`;

// (@zubra/server finds it: zubra.wasm, ZUBRA_COMPILER, or this repository's target/ folder.)
const { findCompiler } = await import('@zubra/server');
const find = async () => findCompiler(); // (it looks again each time)
let found = await find().catch(() => null);
if (!found) {
  const cargo = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (cargo.status === 0) {
    console.log('zubra: building the compiler once (cargo build at the repository root)…');
    const build = spawnSync('cargo', ['build'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
    if (build.status === 0) found = await find().catch(() => null);
  }
}
if (!found) {
  console.error(`\nzubra: no compiler found.\n${HOW_TO}\n`);
  process.exit(1);
}
console.log(`zubra: using the ${found.kind} compiler (${found.path})`);
