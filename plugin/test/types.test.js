// The package's own typings: a TypeScript config file imports each bundler entry by its package
// name, as an app does, and TypeScript checks the options. Needs only TypeScript.
// `npm test` in plugin/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

/** Type-check `files` in a project inside plugin/, where `@zubra/unplugin` resolves to this package. */
function typecheck(name, files) {
  const root = join(here, '.tmp', `types-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [file, source] of Object.entries(files)) writeFileSync(join(root, file), source);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022',
      lib: ['es2022', 'dom'], skipLibCheck: true, types: [],
    },
    files: Object.keys(files),
  }));
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], { encoding: 'utf8', cwd: root });
  return (result.stdout + result.stderr).split('\n').filter((line) => /error TS\d+/.test(line));
}

test('every bundler entry has typings, and a Vite config type-checks with options', () => {
  const errors = typecheck('ok', {
    'vite.config.mts': `
      import { defineConfig } from 'vite';
      import zubra from '@zubra/unplugin/vite';
      export default defineConfig({ plugins: [zubra(), zubra({ framework: 'react', dts: false, ssr: false, devtools: true })] });
    `,
    'others.mts': `
      import rollup from '@zubra/unplugin/rollup';
      import webpack from '@zubra/unplugin/webpack';
      import esbuild from '@zubra/unplugin/esbuild';
      import rspack from '@zubra/unplugin/rspack';
      import astro from '@zubra/unplugin/astro';
      import unplugin, { isLightDom, variantFor } from '@zubra/unplugin';
      export const plugins = [rollup(), webpack({ runtime: '@zubra/runtime' }), esbuild(), rspack(), astro({ framework: 'element' })];
      export const name: string = rollup().name;
      export const light: boolean = isLightDom('<x-y></x-y>');
      export const variant: 'element' | 'react' | 'vue' = variantFor('', 'App.tsx', 'react');
      export const vite = unplugin.vite;
    `,
  });
  assert.deepEqual(errors, []);
});

test('a wrong option is a type error', () => {
  const errors = typecheck('bad', {
    'vite.config.mts': `
      import zubra from '@zubra/unplugin/vite';
      export const a = zubra({ framework: 'svelte' });
      export const b = zubra({ dts: 'yes' });
      export const c = zubra({ compilr: 'zubra' });
    `,
  });
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.match(errors[0], /'"svelte"' is not assignable/);
  assert.match(errors[1], /'string' is not assignable to type 'boolean \| undefined'/);
  assert.match(errors[2], /'compilr' does not exist/);
});
