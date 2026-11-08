// create-mnx: what it writes for each framework, and its command line. (The apps it writes are
// built and used in Chromium by examples/frameworks/test/create.test.js and the plugin's tests.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAMEWORKS, create, parse } from '../index.js';

const work = () => mkdtempSync(join(tmpdir(), 'create-mnx-'));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

for (const framework of Object.keys(FRAMEWORKS)) {
  test(`${framework}: an app with the component, the plugin, a test, and no placeholders left`, () => {
    const dir = join(work(), 'My App');
    const files = create(dir, framework);
    for (const file of ['.gitignore', 'README.md', 'package.json', 'src/components/hello-counter.mnx', 'test/app.test.js', 'test/build.js', 'AGENTS.md', 'skills/mnx-component/SKILL.md', 'skills/mnx-consume/SKILL.md']) {
      assert.ok(files.includes(file), `${file} in ${files.join(', ')}`);
    }
    for (const file of files) {
      assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /\{\{(name|title|version|framework)\}\}/, file);
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-app');
    assert.equal(pkg.dependencies['@mnx/runtime'], `^${version}`);
    assert.equal(pkg.devDependencies['@mnx/unplugin'], `^${version}`);
    assert.ok(pkg.scripts.dev && pkg.scripts.build && pkg.scripts.test);
    const config = files.find((file) => /^(vite|astro)\.config\./.test(file));
    assert.match(readFileSync(join(dir, config), 'utf8'), /@mnx\/unplugin\/(vite|astro)/);
    assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /^# My App/);
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /^# My App/);
  });
}

test('refuses a directory with files in it, and an unknown framework', () => {
  const dir = work();
  writeFileSync(join(dir, 'keep.txt'), '');
  assert.throws(() => create(dir, 'react'), /isn't empty/);
  assert.throws(() => create(join(dir, 'new'), 'ember'), /unknown framework "ember"/);
  mkdirSync(join(dir, 'empty'));
  assert.ok(create(join(dir, 'empty'), 'vanilla').length > 0, 'an empty directory is fine');
});

test('command line: arguments, and a run without a terminal', () => {
  assert.deepEqual(parse(['app', '--framework', 'vue']), { dir: 'app', framework: 'vue', yes: false, help: false });
  assert.deepEqual(parse(['--template=react', '-y']), { dir: null, framework: 'react', yes: true, help: false });
  assert.throws(() => parse(['a', 'b']), /unexpected argument b/);
  const cwd = work();
  const out = execFileSync(process.execPath, [new URL('../index.js', import.meta.url).pathname, 'site', '--framework', 'svelte'], { cwd, encoding: 'utf8' });
  assert.match(out, /An mnx app \(Svelte\) is in site/);
  assert.match(out, /cd site\n {2}npm install/);
  assert.match(readFileSync(join(cwd, 'site/src/App.svelte'), 'utf8'), /<hello-counter/);
  // No terminal and no framework: plain HTML, in mnx-app.
  execFileSync(process.execPath, [new URL('../index.js', import.meta.url).pathname], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(readFileSync(join(cwd, 'mnx-app/index.html'), 'utf8'), /<hello-counter/);
});
