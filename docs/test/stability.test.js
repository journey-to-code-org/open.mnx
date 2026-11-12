// docs/stability.md gives every npm package entry and command a tier. These tests keep it complete
// in both directions: a new export or bin without a row fails, and so does a row for one that's gone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** The published packages, by folder. A new published package goes here and into the page. */
export const PACKAGES = ['runtime', 'compiler', 'server', 'plugin', 'actions', 'sync', 'editors/language-server', 'prettier-plugin', 'create'];

export const TIERS = ['Stable', 'Supported', 'Experimental'];

/** Every entry a package publishes: `name` for ".", `name/sub` for "./sub", `bin <command>` for each command. */
export function packageEntries(pkg) {
  const entries = [];
  if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
    const keys = Object.keys(pkg.exports);
    // A conditions-only exports object ({ import, types }) is the package root.
    if (keys.every((key) => key.startsWith('.'))) {
      for (const key of keys) entries.push(key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`);
    } else entries.push(pkg.name);
  } else if (pkg.exports || pkg.main || !pkg.bin) entries.push(pkg.name);
  const bin = typeof pkg.bin === 'string' ? { [pkg.name.split('/').pop()]: pkg.bin } : pkg.bin ?? {};
  for (const command of Object.keys(bin)) entries.push(`bin ${command}`);
  return entries;
}

/** Rows of the page's tables whose first cell is a backticked entry: { entry, tier, line }. */
export function documentedEntries(markdown) {
  const rows = [];
  markdown.split('\n').forEach((text, index) => {
    const cells = text.split('|').slice(1, -1).map((cell) => cell.trim());
    const match = cells[0]?.match(/^`([^`]+)`$/);
    if (match && cells.length >= 2) rows.push({ entry: match[1], tier: cells[1], line: index + 1 });
  });
  return rows;
}

/** Problems with the page against the packages: missing rows, unknown entries, bad tiers, duplicates. */
export function stabilityProblems(markdown, packages) {
  const problems = [];
  const expected = new Set(packages.flatMap(packageEntries));
  const names = new Set(packages.map((pkg) => pkg.name));
  const rows = documentedEntries(markdown);
  const seen = new Set();
  for (const { entry, tier, line } of rows) {
    const isPackageEntry = entry.startsWith('bin ') || [...names].some((name) => entry === name || entry.startsWith(`${name}/`));
    if (!isPackageEntry) continue;
    if (!expected.has(entry)) problems.push(`line ${line}: ${entry} is not an entry of any published package`);
    if (!TIERS.includes(tier)) problems.push(`line ${line}: ${entry} has tier "${tier}", not one of ${TIERS.join(', ')}`);
    if (seen.has(entry)) problems.push(`line ${line}: ${entry} is listed twice`);
    seen.add(entry);
  }
  for (const entry of expected) if (!seen.has(entry)) problems.push(`${entry} has no row in docs/stability.md`);
  return problems;
}

const readPackage = (folder) => JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8'));

test('every published entry and command has exactly one tiered row, and every row is real', () => {
  const markdown = readFileSync(join(root, 'docs/stability.md'), 'utf8');
  const packages = PACKAGES.map(readPackage);
  for (const pkg of packages) assert.ok(!pkg.private, `${pkg.name} is private; take it out of PACKAGES`);
  assert.deepEqual(stabilityProblems(markdown, packages), []);
});

test('every published package in the repository is in PACKAGES', () => {
  // Folders with a package.json that npm could publish, besides examples, templates and the site.
  const candidates = ['runtime', 'compiler', 'server', 'plugin', 'actions', 'sync', 'editors/language-server', 'editors/vscode', 'editors/devtools', 'prettier-plugin', 'create'];
  for (const folder of candidates) {
    const pkg = readPackage(folder);
    // The VS Code extension is published to the Marketplace, not npm, and has no entries.
    const published = !pkg.private && !pkg.engines?.vscode;
    assert.equal(PACKAGES.includes(folder), published, `${folder} (${pkg.name})`);
  }
});

test('the checks find a missing row, an unknown entry, a bad tier and a duplicate', () => {
  const pkg = { name: '@x/lib', exports: { '.': './a.js', './sub': './b.js' }, bin: { lib: 'cli.js' } };
  assert.deepEqual(packageEntries(pkg), ['@x/lib', '@x/lib/sub', 'bin lib']);
  const page = (rows) => ['| Entry | Tier |', '|---|---|', ...rows].join('\n');
  const complete = ['| `@x/lib` | Stable |', '| `@x/lib/sub` | Experimental |', '| `bin lib` | Supported |'];
  assert.deepEqual(stabilityProblems(page(complete), [pkg]), []);
  assert.match(stabilityProblems(page(complete.slice(0, 2)), [pkg]).join(), /bin lib has no row/);
  assert.match(stabilityProblems(page([...complete, '| `@x/lib/gone` | Stable |']), [pkg]).join(), /@x\/lib\/gone is not an entry/);
  assert.match(stabilityProblems(page(['| `@x/lib` | Solid |', ...complete.slice(1)]), [pkg]).join(), /tier "Solid"/);
  assert.match(stabilityProblems(page([...complete, complete[0]]), [pkg]).join(), /listed twice/);
  // Rows naming something else (a contract, a crate) aren't package entries and are left alone.
  assert.deepEqual(stabilityProblems(page([...complete, '| `include_zb!` | Experimental |']), [pkg]), []);
  // A package with only a root (string exports, or none) is its name.
  assert.deepEqual(packageEntries({ name: 'solo', main: 'index.js' }), ['solo']);
  assert.deepEqual(packageEntries({ name: 'create-x', bin: { 'create-x': 'index.js' } }), ['bin create-x']);
});
