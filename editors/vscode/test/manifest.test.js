// The extension's manifest: it formats .zb by default, and passes the width setting to the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'));

test('the extension is the default formatter for .zb', () => {
  assert.equal(manifest.contributes.configurationDefaults['[zubra]']['editor.defaultFormatter'], `${manifest.publisher}.${manifest.name}`);
  assert.ok(manifest.categories.includes('Formatters'));
});

test('the width setting reaches the language server', () => {
  assert.equal(manifest.contributes.configuration.properties['zubra.format.printWidth'].default, 100);
  const client = readFileSync(join(here, '../extension.js'), 'utf8');
  assert.match(client, /settings\.get\('format\.printWidth'\)/);
  assert.match(client, /initializationOptions: \{ compiler, printWidth \}/);
});
