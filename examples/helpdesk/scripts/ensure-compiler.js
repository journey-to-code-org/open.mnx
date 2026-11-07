// Runs before `npm start` and `npm test`: make sure there's an mnx compiler (see src/compiler.js),
// building the CLI with cargo if that's the way to get one.
import { spawnSync } from 'node:child_process';
import { HOW_TO, findCompiler, repo } from '../src/compiler.js';

let found = findCompiler();
if (!found) {
  const cargo = spawnSync('cargo', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  if (cargo.status === 0) {
    console.log('mnx: building the compiler once (cargo build at the repository root)…');
    const build = spawnSync('cargo', ['build'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
    if (build.status === 0) found = findCompiler();
  }
}
if (!found) {
  console.error(`\nmnx: no compiler found.\n${HOW_TO}\n`);
  process.exit(1);
}
console.log(`mnx: using the ${found.kind} compiler (${found.path})`);
