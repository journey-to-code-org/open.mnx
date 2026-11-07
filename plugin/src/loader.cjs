// A webpack-style loader for `.mnx` files, for bundlers that take loaders but not plugins:
// Next.js's Turbopack (`turbopack.rules`), and webpack itself.
//
//   // next.config.js
//   export default {
//     turbopack: { rules: { '*.mnx': { loaders: ['@mnx/unplugin/loader'], as: '*.js' } } },
//   };
//
// The module defines the element (importing a component's own `.mnx` imports, which go through
// the loader too) and, as its default export, the element as a React component (a client
// component). `?element` imports the element itself instead. Options: `{ runtime, react: false,
// server: true }`.
//
// `server: true`, for the server's build, also registers how to render the component there
// (with @mnx/compiler, from its sources embedded in the module). Then the React wrapper renders
// a shadow-DOM component's declarative shadow root into the server's HTML, so it shows before
// JavaScript (Next.js, which has no HTML hook for @mnx/server's injectShadowRoots):
//
//   '*.mnx': [
//     { condition: 'browser', loaders: ['@mnx/unplugin/loader'], as: '*.js' },
//     { condition: { not: 'browser' }, loaders: [{ loader: '@mnx/unplugin/loader', options: { server: true } }], as: '*.js' },
//   ],
'use strict';

const { existsSync } = require('node:fs');
const { dirname, join, relative, sep } = require('node:path');

// Inside the mnx repository, the CLI from `cargo build` stands in for @mnx/compiler's
// WebAssembly build (as in the plugin).
function findCli(from) {
  for (let dir = from, up = 0; up < 10; up++, dir = dirname(dir)) {
    for (const profile of ['debug', 'release']) {
      const cli = join(dir, 'target', profile, `mnx${process.platform === 'win32' ? '.exe' : ''}`);
      if (existsSync(cli)) return cli;
    }
  }
  return null;
}

/** The module's server renderer: @mnx/compiler, from the component's sources (by relative path). */
function serverRenderer(path, files, runtime, compilerModule) {
  const paths = Object.keys(files);
  let common = dirname(path);
  while (!paths.every((file) => file.startsWith(common + sep))) common = dirname(common);
  const key = (file) => `/${relative(common, file).split(sep).join('/')}`;
  const embedded = Object.fromEntries(paths.map((file) => [key(file), files[file]]));
  return `
import { registerRenderer as $mnxRegister } from ${JSON.stringify(`${runtime}/server`)};
import { request as $mnxRequest } from ${JSON.stringify(compilerModule)};
$mnxRegister(tag, (props, slots) => {
  const response = $mnxRequest({ emit: 'html', path: ${JSON.stringify(key(path))}, files: ${JSON.stringify(embedded)}, props, slots, slotSource: 'html', partial: true });
  if (!response.ok) throw new Error(response.error);
  return response.output;
});
`;
}

module.exports = function mnxLoader() {
  const callback = this.async();
  const options = (typeof this.getOptions === 'function' ? this.getOptions() : this.query) || {};
  const runtime = options.runtime || '@mnx/runtime';
  const path = this.resourcePath;
  const element = /(^|[?&])element\b/.test(this.resourceQuery || '');
  import('@mnx/compiler')
    .then((compiler) => {
      if (!compiler.available() && !process.env.MNX_COMPILER) {
        const cli = findCli(this.rootContext || process.cwd()) || findCli(__dirname);
        if (cli) process.env.MNX_COMPILER = cli;
      }
      const files = compiler.sources(path);
      for (const file of Object.keys(files)) if (file !== path) this.addDependency(file);
      const response = compiler.compileFile(path, { emit: 'js', runtime, keepImports: true });
      if (!response.ok) throw new Error(response.error);
      for (const warning of response.warnings) this.emitWarning(new Error(warning));
      let code = response.output;
      if (options.server) code += serverRenderer(path, files, runtime, options.compilerModule || '@mnx/compiler');
      if (element || options.react === false) return callback(null, code);
      // The element, and the element as a React component (React's hooks: a client component).
      code = code.replace(/^export default \$define\(/m, 'const $element = $define(');
      callback(null, `'use client';\n${code}\nimport { wrap as $wrap } from ${JSON.stringify(`${runtime}/react`)};\nexport { $element as Element };\nexport default $wrap($element);\n`);
    })
    .catch((error) => callback(error));
};
