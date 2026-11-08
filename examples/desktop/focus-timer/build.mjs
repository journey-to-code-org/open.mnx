// Build the renderer into dist/: esbuild with zubra's esbuild plugin, one ES module.
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
await esbuild.build({ entryPoints: [join(here, 'src/app.js')], bundle: true, format: 'esm', outdir: out, plugins: [zubra()], target: 'chrome130', logLevel: 'warning' });
console.log(`Built ${out}`);
