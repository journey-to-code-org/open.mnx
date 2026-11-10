// `zubra` from npm: `add` (the registry) and `build --lib`, through the command line.
// Uses zubra.wasm when built; otherwise the CLI in target/debug (cargo build).
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
const env = { ...process.env, ZUBRA_COMPILER: process.env.ZUBRA_COMPILER ?? join(repo, 'target/debug/zubra') };
const zubra = (args, cwd) => spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' });

test('the registry lists 26 components, each with a description, category and files', () => {
  const { components } = readRegistry();
  assert.equal(components.length, 26);
  for (const component of components) {
    assert.ok(component.description.length > 20, component.name);
    assert.ok(['input', 'display', 'app', 'widget'].includes(component.category), component.name);
    assert.deepEqual(component.files, [`${component.name}.zb`]);
  }
  const index = spawnSync(process.execPath, [join(repo, 'registry/build-index.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(index.status, 0, index.stderr);
});

test('zubra add copies components in, never over your edits without --force, and suggests names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zb-add-'));
  let run = zubra(['add', 'tag-input', 'modal-dialog'], dir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /added src\/components\/tag-input\.zb, src\/components\/modal-dialog\.zb/);
  assert.equal(readFileSync(join(dir, 'src/components/tag-input.zb'), 'utf8'), readFileSync(join(repo, 'registry/components/tag-input.zb'), 'utf8'));

  writeFileSync(join(dir, 'src/components/tag-input.zb'), '<!-- mine -->');
  run = zubra(['add', 'tag-input'], dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /already exists \(--force replaces it\)/);
  assert.equal(readFileSync(join(dir, 'src/components/tag-input.zb'), 'utf8'), '<!-- mine -->');
  assert.equal(zubra(['add', 'tag-input', '--force'], dir).status, 0);

  run = zubra(['add', 'stepper-quantity'], dir);
  assert.match(run.stderr, /no component "stepper-quantity"/);
  assert.match(zubra(['add', 'toggle-swich'], dir).stderr, /did you mean toggle-switch\?/);
  assert.match(zubra(['add', '--list'], dir).stdout, /^chat-message +One message/m);
  // Into another directory, through the API.
  assert.deepEqual(add(['star-rating'], { target: join(dir, 'ui') }), [join(dir, 'ui/star-rating.zb')]);
  // A component that imports npm packages says which to install.
  run = zubra(['add', 'combo-box', 'tab-list'], dir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /they import @zag-js\/vanilla, @zag-js\/combobox: npm install @zag-js\/vanilla @zag-js\/combobox/);
  assert.doesNotMatch(zubra(['add', 'accordion-panel'], dir).stdout, /npm install/);
});

test('zubra build --lib and zubra check, from the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zb-lib-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/widgets', version: '0.3.0', license: 'MIT' }));
  execFileSync(process.execPath, [cli, 'add', 'quantity-stepper', 'toggle-switch'], { cwd: dir, env });
  let run = zubra(['build', '--lib', 'src/components'], dir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /built 2 components into dist: <quantity-stepper> <toggle-switch>/);
  const pkg = JSON.parse(readFileSync(join(dir, 'dist/package.json'), 'utf8'));
  assert.deepEqual([pkg.name, pkg.version, pkg.license], ['@acme/widgets', '0.3.0', 'MIT']);
  assert.ok(existsSync(join(dir, 'dist/react/toggle-switch.d.ts')));
  // A skill for coding agents, from the manifest: every component, its props, events and slots.
  const skill = readFileSync(join(dir, 'dist/skills/using-acme-widgets/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: using-acme-widgets\ndescription: Use the @acme\/widgets web components \(<quantity-stepper>, <toggle-switch>\)/);
  assert.match(skill, /### `<toggle-switch>`[\s\S]*\| `checked` \| `boolean` \| `false` \| two-way: fires `checkedchange` \|/);
  assert.match(skill, /Import `@acme\/widgets\/quantity-stepper`/);

  run = zubra(['check', 'src/components/quantity-stepper.zb'], dir);
  assert.match(run.stdout, /checked 1 file: no errors/);
  writeFileSync(join(dir, 'src/components/broken.zb'), '<x-broken><p>{nope(</p></x-broken>');
  run = zubra(['build', '--lib', 'src/components'], dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /broken\.zb:1:/);
  run = zubra(['compile', 'src/components/toggle-switch.zb', '--emit', 'js'], dir);
  assert.match(run.stdout, /\$define\(tag/);
});

test('zubra convert: a React component becomes a zubra JSX component next to it; what is left is reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zb-convert-'));
  writeFileSync(join(dir, 'Toggle.jsx'), "import { useState } from 'react';\n\nexport default function Toggle({ label = 'On' }) {\n  const [on, setOn] = useState(false);\n  return <button aria-pressed={on} onClick={() => setOn(!on)}>{label}</button>;\n}\n");
  let run = zubra(['convert', 'Toggle.jsx', '--prefix', 'ui'], dir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /wrote ui-toggle\.zb\.jsx \(<ui-toggle>\)/);
  const out = readFileSync(join(dir, 'ui-toggle.zb.jsx'), 'utf8');
  assert.match(out, /export default function UiToggle\(\{ label = 'On' \}\) \{\n {2}let on = false;/);
  assert.match(out, /onClick=\{\(\) => \(on = !on\)\}/);
  assert.equal(zubra(['check', 'ui-toggle.zb.jsx'], dir).status, 0);

  writeFileSync(join(dir, 'Menu.jsx'), "import { useContext } from 'react';\nexport default function UserMenu() {\n  const theme = useContext(Theme);\n  return <nav />;\n}\n");
  run = zubra(['convert', 'Menu.jsx', '--stdout'], dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /`useContext` became `inject\(\)`, but its context comes from elsewhere/);
  assert.match(run.stderr, /1 thing to finish by hand/);
});

test('zubra build --lib --watch rebuilds on a change, and keeps the last good build through an error', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'zb-watch-'));
  mkdirSync(join(dir, 'components'));
  const component = join(dir, 'components/hello-tag.zb');
  writeFileSync(component, '<hello-tag name="you"><p>Hello {name}</p></hello-tag>\n');
  const child = spawn(process.execPath, [cli, 'build', '--lib', 'components', '--out', 'ui', '--watch'], { cwd: dir, env });
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const until = async (test) => {
    for (let tries = 0; tries < 100 && !test(); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(test(), output);
  };
  try {
    await until(() => /watching/.test(output));
    const built = () => readFileSync(join(dir, 'ui/hello-tag.js'), 'utf8');
    assert.match(built(), /Hello /);
    writeFileSync(component, '<hello-tag name="you"><p>Howdy {name}</p></hello-tag>\n');
    await until(() => existsSync(join(dir, 'ui/hello-tag.js')) && /Howdy/.test(built()));
    output = '';
    writeFileSync(component, '<hello-tag name="you"><p>{nope}</p></hello-tag>\n');
    await until(() => /nope/.test(output));
    assert.match(built(), /Howdy/, 'the last good build is still there');
    assert.equal(existsSync(join(dir, 'ui.building')), false);
  } finally {
    child.kill();
  }
});

test('zubra fmt formats in place, checks, and reads standard input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zubra-fmt-'));
  const messy = '<x-a>\n<p>a</p>\n</x-a>\n';
  const tidy = '<x-a>\n  <p>a</p>\n</x-a>\n';
  writeFileSync(join(dir, 'a.zb'), messy);
  writeFileSync(join(dir, 'b.zb'), tidy);

  let result = zubra(['fmt', '.', '--check'], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /would format a\.zb/);
  assert.doesNotMatch(result.stdout, /b\.zb/);
  assert.match(result.stderr, /1 file is not formatted/);
  assert.equal(readFileSync(join(dir, 'a.zb'), 'utf8'), messy);

  result = zubra(['fmt', '.'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, 'a.zb'), 'utf8'), tidy);
  assert.equal(zubra(['fmt', '.', '--check'], dir).status, 0);

  result = spawnSync(process.execPath, [cli, 'fmt', '--stdin', '--tabs'], { cwd: dir, env, encoding: 'utf8', input: messy });
  assert.equal(result.stdout, '<x-a>\n\t<p>a</p>\n</x-a>\n');
  result = spawnSync(process.execPath, [cli, 'fmt', '--stdin'], { cwd: dir, env, encoding: 'utf8', input: '<x-a>\n<p>\n</x-a>\n' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /closing tag/);
});
