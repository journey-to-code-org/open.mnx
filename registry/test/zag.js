// combo-box imports Zag: its machine and the adapter, bundled once for the browser tests and
// mapped to their specifiers. The adapter's own import of the runtime stays the page's runtime.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtime = join(dirname(fileURLToPath(import.meta.url)), '../../runtime');
const { build } = createRequire(join(runtime, 'package.json'))('esbuild');
const bundle = (await build({
  stdin: { contents: "export * as combobox from '@zag-js/combobox'; export { useMachine, normalizeProps } from './src/zag.js';", resolveDir: runtime },
  bundle: true,
  format: 'esm',
  write: false,
  external: ['@zubra/runtime'],
  plugins: [{ name: 'runtime', setup: (build) => build.onResolve({ filter: /^\.\/element\.js$/ }, () => ({ path: '@zubra/runtime', external: true })) }],
})).outputFiles[0].text;

/** For the harness's `useBrowser(components, files, imports)`. */
export const files = {
  'zag-bundle.js': bundle,
  'zag-combobox.js': "import { combobox } from './zag-bundle.js'; export const { machine, connect, collection } = combobox;",
  'zag-adapter.js': "export { useMachine, normalizeProps } from './zag-bundle.js';",
};
export const imports = { '@zag-js/combobox': '/zag-combobox.js', '@zubra/runtime/zag': '/zag-adapter.js' };
