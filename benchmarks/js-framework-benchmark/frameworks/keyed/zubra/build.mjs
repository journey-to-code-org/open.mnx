// Bundles src/main.js into dist/main.js: esbuild with Zubra's esbuild plugin, which compiles the
// .zb import, and the runtime's production build.
import * as esbuild from 'esbuild';
import zubra from '@zubra/unplugin/esbuild';

const options = {
  entryPoints: ['src/main.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  outfile: 'dist/main.js',
  conditions: ['production'],
  plugins: [zubra()],
  logLevel: 'warning',
};

if (process.argv.includes('--watch')) await (await esbuild.context(options)).watch();
else await esbuild.build(options);
