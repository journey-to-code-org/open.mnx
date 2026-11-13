// Builds zubra-<version>.vsix next to package.json:  npm run package
//
// The extension depends on @zubra/language-server by path (`file:../language-server`) so the repo's
// tests run against the working copy, but a .vsix has to carry the server in its own node_modules.
// So this packs a copy whose dependency is the published version (the packages are released together),
// installs only the runtime dependencies there, and checks the server made it into the package.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'zubra-vsix-'));
// A shell, because npm and npx are .cmd files on Windows, which Node won't start directly. The arguments are fixed strings.
const run = (command, args, { show = true } = {}) => execFileSync(command, args, { cwd: work, stdio: ['ignore', show ? 'inherit' : 'pipe', 'inherit'], shell: true })?.toString() ?? '';
const step = (message) => console.log(`vscode: ${message}`);
try {
  for (const name of ['LICENSE', 'README.md', 'icon.png', 'extension.js', 'language-configuration.json', 'syntaxes', 'icons', '.vscodeignore']) cpSync(join(here, name), join(work, name), { recursive: true });
  manifest.dependencies['@zubra/language-server'] = manifest.version;
  delete manifest.devDependencies;
  writeFileSync(join(work, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  step('installing the extension\'s dependencies (the first run can take a minute)…');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock']);
  step('checking what would go in the package (npx fetches @vscode/vsce the first time)…');
  const files = run('npx', ['--yes', '@vscode/vsce', 'ls'], { show: false });
  for (const needed of ['node_modules/@zubra/language-server/server.js', 'node_modules/@zubra/language-server/packages.js', 'node_modules/@zubra/language-server/typecheck-worker.js', 'node_modules/@zubra/language-server/typescript.js', 'node_modules/@zubra/language-server/typescript-plugin/index.js', 'node_modules/@zubra/language-server/typescript-plugin/package.json', 'node_modules/@zubra/language-server/typings.mjs', 'node_modules/typescript/lib/typescript.js', 'node_modules/vscode-languageclient/package.json', 'icon.png', 'README.md', 'icons/zb-light.svg', 'icons/zb-dark.svg']) {
    if (!files.includes(needed)) throw new Error(`the package would be missing ${needed}`);
  }
  const vsix = `zubra-${manifest.version}.vsix`;
  step('packaging…');
  run('npx', ['@vscode/vsce', 'package', '--out', vsix]);
  copyFileSync(join(work, vsix), join(here, vsix)); // not renamed: the temp folder can be on another drive
  console.log(`vscode: ${join(here, vsix)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
