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
// component). `?element` imports the element itself instead. Options: `{ runtime, react: false }`.
'use strict';

const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');

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
      for (const file of Object.keys(compiler.sources(path))) if (file !== path) this.addDependency(file);
      const response = compiler.compileFile(path, { emit: 'js', runtime, keepImports: true });
      if (!response.ok) throw new Error(response.error);
      for (const warning of response.warnings) this.emitWarning(new Error(warning));
      let code = response.output;
      if (element || options.react === false) return callback(null, code);
      // The element, and the element as a React component (React's hooks: a client component).
      code = code.replace(/^export default \$define\(/m, 'const $element = $define(');
      callback(null, `'use client';\n${code}\nimport { wrap as $wrap } from ${JSON.stringify(`${runtime}/react`)};\nexport { $element as Element };\nexport default $wrap($element);\n`);
    })
    .catch((error) => callback(error));
};
