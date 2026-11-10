// The manifest: valid Manifest V3, every file it names is here, and its version is the project's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('a Manifest V3 devtools extension, asking for no permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.devtools_page, 'devtools.html');
  assert.equal(manifest.permissions, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

test('Firefox: it declares that it collects no data (addons.mozilla.org requires the key)', () => {
  const gecko = manifest.browser_specific_settings.gecko;
  assert.deepEqual(gecko.data_collection_permissions, { required: ['none'] });
  // The key is understood from Firefox 140 (desktop).
  assert.ok(Number.parseFloat(gecko.strict_min_version) >= 140, gecko.strict_min_version);
  assert.ok(Number.parseFloat(manifest.browser_specific_settings.gecko_android.strict_min_version) >= 142);
});

test('every file it and its pages name exists', () => {
  const named = [manifest.devtools_page, ...Object.values(manifest.icons), 'pane.html'];
  for (const page of ['devtools.html', 'pane.html']) {
    for (const [, file] of readFileSync(join(root, page), 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)) named.push(file);
  }
  named.push(...[...readFileSync(join(root, 'devtools.js'), 'utf8').matchAll(/setPage\('([^']+)'\)/g)].map(([, file]) => file));
  for (const file of named) assert.ok(existsSync(join(root, file)), file);
});

test('its version is the project\'s (scripts/bump-version.sh sets both)', () => {
  const vscode = JSON.parse(readFileSync(join(root, '../vscode/package.json'), 'utf8'));
  assert.equal(manifest.version, vscode.version);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, vscode.version);
});
