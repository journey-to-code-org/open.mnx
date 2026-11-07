// `mnx` from npm: `add` (the registry) and `build --lib`, through the command line.
// Uses mnx.wasm when built; otherwise the CLI in target/debug (cargo build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { add, readRegistry } from '../cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const cli = join(here, '../cli.js');
const env = { ...process.env, MNX_COMPILER: process.env.MNX_COMPILER ?? join(repo, 'target/debug/mnx') };
const mnx = (args, cwd) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });

test('the registry lists 20 components, each with a description, category and files', () => {
  const { components } = readRegistry();
  assert.equal(components.length, 20);
  for (const component of components) {
    assert.ok(component.description.length > 20, component.name);
    assert.ok(['input', 'display', 'app'].includes(component.category), component.name);
    assert.deepEqual(component.files, [`${component.name}.mnx`]);
  }
  const index = spawnSync(process.execPath, [join(repo, 'registry/build-index.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(index.status, 0, index.stderr);
});

test('mnx add copies components in, never over your edits without --force, and suggests names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnx-add-'));
  let run = mnx(['add', 'tag-input', 'modal-dialog'], dir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /added src\/components\/tag-input\.mnx, src\/components\/modal-dialog\.mnx/);
  assert.equal(readFileSync(join(dir, 'src/components/tag-input.mnx'), 'utf8'), readFileSync(join(repo, 'registry/components/tag-input.mnx'), 'utf8'));

  writeFileSync(join(dir, 'src/components/tag-input.mnx'), '<!-- mine -->');
  run = mnx(['add', 'tag-input'], dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /already exists \(--force replaces it\)/);
  assert.equal(readFileSync(join(dir, 'src/components/tag-input.mnx'), 'utf8'), '<!-- mine -->');
  assert.equal(mnx(['add', 'tag-input', '--force'], dir).status, 0);

  run = mnx(['add', 'stepper-quantity'], dir);
  assert.match(run.stderr, /no component "stepper-quantity"/);
  assert.match(mnx(['add', 'toggle-swich'], dir).stderr, /did you mean toggle-switch\?/);
  assert.match(mnx(['add', '--list'], dir).stdout, /^chat-message +One message/m);
  // Into another directory, through the API.
  assert.deepEqual(add(['star-rating'], { target: join(dir, 'ui') }), [join(dir, 'ui/star-rating.mnx')]);
});

test('mnx build --lib and mnx check, from the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnx-lib-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/widgets', version: '0.3.0', license: 'MIT' }));
  execFileSync(process.execPath, [cli, 'add', 'quantity-stepper', 'toggle-switch'], { cwd: dir, env });
  let run = mnx(['build', '--lib', 'src/components'], dir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /built 2 components into dist: <quantity-stepper> <toggle-switch>/);
  const pkg = JSON.parse(readFileSync(join(dir, 'dist/package.json'), 'utf8'));
  assert.deepEqual([pkg.name, pkg.version, pkg.license], ['@acme/widgets', '0.3.0', 'MIT']);
  assert.ok(existsSync(join(dir, 'dist/react/toggle-switch.d.ts')));

  run = mnx(['check', 'src/components/quantity-stepper.mnx'], dir);
  assert.match(run.stdout, /checked 1 file: no errors/);
  writeFileSync(join(dir, 'src/components/broken.mnx'), '<x-broken><p>{nope(</p></x-broken>');
  run = mnx(['build', '--lib', 'src/components'], dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /broken\.mnx:1:/);
  run = mnx(['compile', 'src/components/toggle-switch.mnx', '--emit', 'js'], dir);
  assert.match(run.stdout, /\$define\(tag/);
});
