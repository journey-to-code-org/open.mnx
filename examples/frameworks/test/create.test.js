// `npm create mnx`: each starter app is written here (so it resolves this directory's
// toolchains), then its own browser test runs: it builds the app and clicks the counter.
// (The Astro starter is covered by the plugin's tests, which have Astro installed.)
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { create } from '../../../create/index.js';
import { examples } from './harness.js';

for (const framework of ['vanilla', 'react', 'vue', 'svelte', 'solid', 'preact', 'lit', 'angular']) {
  test(`npm create mnx -- --framework ${framework}: the starter's own test passes`, () => {
    const dir = join(examples, '.tmp-create', framework);
    rmSync(dir, { recursive: true, force: true });
    create(dir, framework, { name: `${framework} starter` });
    try {
      execFileSync(process.execPath, ['--test', 'test/app.test.js'], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
    } catch (error) {
      throw new Error(`the ${framework} starter's test failed:\n${error.stdout}${error.stderr}`);
    }
  });
}
