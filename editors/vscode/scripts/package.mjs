// Builds zubra-<version>.vsix next to package.json:  npm run package
//
// The extension depends on @zubra/language-server by path (`file:../language-server`) so the repo's
// tests run against the working copy, but a .vsix has to carry the server in its own node_modules.
// So this packs a copy whose dependency is the published version (the packages are released together),
// installs only the runtime dependencies there, and checks the server made it into the package.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'zubra-vsix-'));
const run = (command, args) => execFileSync(command, args, { cwd: work, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
try {
  for (const name of ['LICENSE', 'README.md', 'icon.png', 'extension.js', 'language-configuration.json', 'syntaxes', '.vscodeignore']) cpSync(join(here, name), join(work, name), { recursive: true });
  manifest.dependencies['@zubra/language-server'] = manifest.version;
  delete manifest.devDependencies;
  writeFileSync(join(work, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock']);
  const files = run('npx', ['--yes', '@vscode/vsce', 'ls']);
  for (const needed of ['node_modules/@zubra/language-server/server.js', 'node_modules/vscode-languageclient/package.json', 'icon.png', 'README.md']) {
    if (!files.includes(needed)) throw new Error(`the package would be missing ${needed}`);
  }
  const vsix = `zubra-${manifest.version}.vsix`;
  run('npx', ['@vscode/vsce', 'package', '--out', vsix]);
  renameSync(join(work, vsix), join(here, vsix));
  console.log(`vscode: ${join(here, vsix)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
