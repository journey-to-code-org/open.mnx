// Publishes the six npm packages for the current version, in the order they depend on each other:
//
//   node scripts/publish.mjs [--dry-run]
//
// Run it from the repository on `main`, after the release PR is merged (scripts/bump-version.sh
// set the version, and the changelog has its entry). A package whose version is already on npm is
// skipped, so it can be run again after a failure. --dry-run does everything but publish.
//
// npm may open the browser to authenticate; the compiler is built first (it needs the WebAssembly
// toolchain, and refuses to be packed without zubra.wasm). Afterwards the VS Code extension is
// packaged with `npm run package` in editors/vscode, which installs the language server from npm.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry-run');
// A shell, because npm is a .cmd file on Windows, which Node won't start directly. The arguments are fixed strings.
const npm = (args, cwd, stdio = 'inherit') => spawnSync('npm', args, { cwd, stdio, shell: true, encoding: 'utf8' });

// The order matters: the plugin and the server need the runtime and the compiler, and create-zubra's
// templates need all of them. The compiler is built first.
const packages = [
  { dir: 'runtime' },
  { dir: 'compiler', build: true },
  { dir: 'server' },
  { dir: 'plugin' },
  { dir: 'editors/language-server' },
  { dir: 'create' },
];

const manifest = (dir) => JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8'));
const version = manifest('runtime').version;
const mismatched = packages.filter(({ dir }) => manifest(dir).version !== version).map(({ dir }) => `${dir} is ${manifest(dir).version}`);
if (mismatched.length) throw new Error(`publish: every package should be ${version}: ${mismatched.join(', ')}`);

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
if (!dry && branch !== 'main') throw new Error(`publish: run this on main (you're on ${branch}); merge the release PR and pull first`);
if (!dry && dirty) throw new Error(`publish: the working tree has uncommitted changes:\n${dirty}`);

const published = (name) => npm(['view', `${name}@${version}`, 'version'], repo, 'pipe').stdout.trim() === version;

console.log(`publish: ${version}${dry ? ' (dry run)' : ''}`);
for (const { dir, build } of packages) {
  const { name } = manifest(dir);
  if (!dry && published(name)) { console.log(`publish: ${name}@${version} is already on npm, skipping`); continue; }
  const cwd = join(repo, dir);
  if (build && npm(['run', 'build'], cwd).status !== 0) throw new Error(`publish: building ${name} failed`);
  console.log(`publish: ${name}@${version}`);
  if (npm(['publish', '--access', 'public', ...(dry ? ['--dry-run'] : [])], cwd).status !== 0) {
    throw new Error(`publish: ${name} failed; fix it and run this again (packages already on npm are skipped)`);
  }
}
console.log(`publish: done. Next: tag v${version}, then \`npm run package\` in editors/vscode and upload the .vsix.`);
