// Builds the playground's static site (GitHub Pages serves it):
//
//   node playground/build.mjs [--out <dir>] [--no-frameworks] [--require-wasm]
//
// - the page, its script and styles;
// - @zubra/runtime's source, as the previews import it, and @zubra/sync's;
// - compiler/zubra.wasm (from `npm run build` in compiler/), when it's there;
// - React and Vue as ES modules for their previews, from examples/frameworks' node_modules
//   (`npm ci` there), unless --no-frameworks.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const out = resolve(args[args.indexOf('--out') + 1] && args.includes('--out') ? args[args.indexOf('--out') + 1] : join(here, 'dist'));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'vendor'), { recursive: true });
for (const file of ['index.html', 'app.js', 'highlight.js', 'style.css']) cpSync(join(here, file), join(out, file));
cpSync(join(repo, 'runtime/src'), join(out, 'runtime'), { recursive: true });
// @zubra/sync, for components that start with 'use collection' (the "State on the device" example).
cpSync(join(repo, 'sync/src'), join(out, 'sync'), { recursive: true, filter: (from) => !/(\.d\.ts|server\.js|sqlite\.js)$/.test(from) });

const wasm = join(repo, 'compiler/zubra.wasm');
if (existsSync(wasm)) cpSync(wasm, join(out, 'zubra.wasm'));
else if (flag('--require-wasm')) throw new Error('playground: compiler/zubra.wasm is missing (run `npm run build` in compiler/)');

const frameworks = [];
if (!flag('--no-frameworks')) {
  const toolchain = createRequire(join(repo, 'examples/frameworks/package.json'));
  const { build } = await import(pathToFileURL(toolchain.resolve('esbuild')).href);
  // React is CommonJS: one ES module with React's named exports and React DOM's createRoot
  // (one module, so there's one copy of React). The page maps both `react` and
  // `react-dom/client` to it.
  const React = toolchain('react');
  const names = Object.keys(React).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default');
  await build({
    stdin: {
      contents: `import React from 'react';\nimport client from 'react-dom/client';\nexport default React;\nexport const { ${names.join(', ')} } = React;\nexport const { createRoot, hydrateRoot } = client;\n`,
      resolveDir: join(repo, 'examples/frameworks'),
      sourcefile: 'react.js',
    },
    bundle: true, format: 'esm', minify: true, outfile: join(out, 'vendor/react.js'),
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
  });
  frameworks.push('react');
  cpSync(toolchain.resolve('vue/dist/vue.esm-browser.prod.js'), join(out, 'vendor/vue.js'));
  frameworks.push('vue');
}
writeFileSync(join(out, 'vendor/frameworks.json'), JSON.stringify(frameworks));
console.log(`playground: ${out} (${existsSync(join(out, 'zubra.wasm')) ? 'with' : 'without'} zubra.wasm; previews: html${frameworks.map((name) => `, ${name}`).join('')})`);
