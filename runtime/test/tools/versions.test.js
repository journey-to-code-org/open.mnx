// Every package carries the release's version, and the packages that need the compiler and the
// runtime ask for this release or later (`^<major>.<minor>.0`), so npm installs them together.
// `scripts/bump-version.sh` keeps both true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const json = (path) => JSON.parse(readFileSync(join(repo, path), 'utf8'));
const version = json('runtime/package.json').version;
const range = `^${version.replace(/^(\d+\.\d+)\..*/, '$1.0')}`;

test('every package has the release version', () => {
  for (const path of ['compiler', 'create', 'plugin', 'runtime', 'server', 'editors/language-server', 'editors/vscode']) {
    assert.equal(json(`${path}/package.json`).version, version, path);
  }
  assert.match(readFileSync(join(repo, 'Cargo.toml'), 'utf8'), new RegExp(`^version = "${version.replaceAll('.', '\\.')}"$`, 'm'));
});

test('the plugin and the server ask for this release of the compiler and the runtime', () => {
  for (const path of ['plugin', 'server']) {
    const pkg = json(`${path}/package.json`);
    const wanted = { ...pkg.peerDependencies, ...pkg.dependencies };
    for (const name of ['@zubra/compiler', '@zubra/runtime']) assert.equal(wanted[name], range, `${path}: ${name}`);
  }
});

test('command names point at their file without "./", the form npm 11 keeps when publishing', () => {
  // npm 11 drops a bin written "./cli.js" ("script name … was invalid and removed"), so the
  // package would install without its command.
  for (const path of ['compiler', 'create', 'editors/language-server']) {
    for (const [name, file] of Object.entries(json(`${path}/package.json`).bin)) {
      assert.doesNotMatch(file, /^\.\//, `${path}: bin ${name}`);
    }
  }
});

// The release workflow publishes when the version reaches main, with this section as the notes.
test('the release version has its notes in CHANGELOG.md', () => {
  const notes = execFileSync(process.execPath, [join(repo, 'scripts/release-notes.mjs'), version], { encoding: 'utf8' });
  assert.ok(notes.trim().length > 0);
  assert.doesNotMatch(notes, /^## /m, 'only this version\'s section');
});

// npm's trusted publishing and provenance check the package against the repository it was built in:
// a package whose repository.url doesn't match is refused (as a 404).
test('every published package names this repository and its folder', () => {
  for (const path of ['compiler', 'create', 'plugin', 'runtime', 'server', 'editors/language-server']) {
    const { repository } = json(`${path}/package.json`);
    assert.deepEqual(repository, { type: 'git', url: 'git+https://github.com/journey-to-code-org/zubra.git', directory: path }, path);
  }
});
