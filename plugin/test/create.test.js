// `npm create zubra -- --framework astro`: the starter is written here (so it resolves the
// plugin's Astro), linked to this repository's packages, and its own browser test runs.
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from '../../create/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');

test("npm create zubra -- --framework astro: the starter's own test passes", () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  const dir = join(here, '.tmp-create', 'astro');
  rmSync(dir, { recursive: true, force: true });
  create(dir, 'astro', { name: 'astro starter' });
  mkdirSync(join(dir, 'node_modules/@zubra'), { recursive: true });
  for (const [name, path] of [['unplugin', 'plugin'], ['runtime', 'runtime'], ['compiler', 'compiler']]) {
    symlinkSync(join(repo, path), join(dir, 'node_modules/@zubra', name), 'dir');
  }
  try {
    execFileSync(process.execPath, ['--test', 'test/app.test.js'], {
      cwd: dir, stdio: 'pipe', encoding: 'utf8',
      env: { ...process.env, ZUBRA_COMPILER: process.env.ZUBRA_COMPILER ?? join(repo, 'target/debug/zubra') },
    });
  } catch (error) {
    throw new Error(`the Astro starter's test failed:\n${error.stdout}${error.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
