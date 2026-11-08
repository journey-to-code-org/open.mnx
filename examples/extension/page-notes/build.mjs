// Build the extension into dist/: esbuild with zubra's esbuild plugin. Extension pages and the
// service worker are ES modules; content scripts can't be, so they're bundled as IIFEs. Load
// dist/ as an unpacked extension (chrome://extensions → Developer mode → Load unpacked).
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
// Inside this repository, the CLI from `cargo build` stands in for @zubra/compiler's WebAssembly build.
const cli = ['debug', 'release'].map((profile) => join(here, '../../../target', profile, `zubra${process.platform === 'win32' ? '.exe' : ''}`)).find(existsSync);
if (cli) process.env.ZUBRA_COMPILER ??= cli;
const { default: zubra } = await import('@zubra/unplugin/esbuild');

const out = join(here, 'dist');
rmSync(out, { recursive: true, force: true });
cpSync(join(here, 'static'), out, { recursive: true });

const common = { bundle: true, outdir: out, plugins: [zubra()], target: 'chrome120', logLevel: 'warning', legalComments: 'none' };
const builds = [
  { ...common, entryPoints: ['src/popup.js', 'src/options.js', 'src/background.js'].map((file) => join(here, file)), format: 'esm', splitting: true, chunkNames: 'chunks/[name]-[hash]' },
  { ...common, entryPoints: ['src/bridge.js', 'src/widget.js'].map((file) => join(here, file)), format: 'iife' },
];
if (process.argv.includes('--watch')) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log('Watching src/ (reload the extension in chrome://extensions after a change).');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log(`Built ${out}`);
}
