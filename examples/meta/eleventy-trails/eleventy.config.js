// Eleventy with mnx, and no bundler:
//
// - `{% mnx "trail-card", { … } %}` renders a component to HTML at build time (@mnx/compiler).
// - A transform gives each page the CSS of the components it used and imports their modules.
// - After the build, each component is compiled to a browser module in _site/components/, and
//   @mnx/runtime is copied to _site/vendor/mnx/, for an import map.
//
// MINIFY=1 minifies the HTML, keeping mnx's hydration markers (they're comments: see below).
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Inside this repository, the CLI from `cargo build` stands in for @mnx/compiler's WebAssembly build.
const cli = ['debug', 'release'].map((profile) => join(here, '../../../target', profile, `mnx${process.platform === 'win32' ? '.exe' : ''}`)).find(existsSync);
if (cli) process.env.MNX_COMPILER ??= cli;
const { compileFile, request, sources } = await import('@mnx/compiler');

const COMPONENTS = join(here, 'components');
const names = readdirSync(COMPONENTS).filter((file) => file.endsWith('.mnx')).map((file) => file.slice(0, -4));
const check = (response) => {
  if (!response.ok) throw new Error(response.error);
  return response.output;
};
const path = (name) => join(COMPONENTS, `${name}.mnx`);

// mnx's hydration markers are comments (`<!--[-->`, `<!--]-->`, `<!---->`, `<!--[?-->`, …). A
// minifier that removes comments removes them, and the elements then render afresh instead of
// hydrating. This keeps them and nothing else.
export const MNX_MARKERS = /^[[\]?!]*$/;

export default function (eleventyConfig) {
  const used = new Map(); // page URL → components it rendered

  eleventyConfig.addShortcode('mnx', function (name, props = {}) {
    if (!names.includes(name)) throw new Error(`mnx: no component ${name}`);
    const page = this.page?.url;
    if (!used.has(page)) used.set(page, new Set());
    used.get(page).add(name);
    return check(request({ emit: 'html', path: path(name), files: sources(path(name)), props, partial: true }));
  });

  eleventyConfig.addTransform('mnx', function (html) {
    if (!this.page.outputPath?.endsWith('.html')) return html;
    const components = [...(used.get(this.page.url) ?? [])];
    if (!components.length) return html;
    const css = components.map((name) => check(request({ emit: 'css', path: path(name), files: sources(path(name)) }))).join('\n');
    const modules = components.map((name) => `import '/components/${name}.js';`).join(' ');
    return html
      .replace('</head>', `<style data-mnx-components>${css}</style>\n<script type="importmap">{ "imports": { "@mnx/runtime": "/vendor/mnx/index.js" } }</script>\n</head>`)
      .replace('</body>', `<script type="module">${modules}</script>\n</body>`);
  });

  if (process.env.MINIFY) {
    eleventyConfig.addTransform('minify', async function (html) {
      if (!this.page.outputPath?.endsWith('.html')) return html;
      const { minify } = await import('html-minifier-terser');
      return minify(html, {
        collapseWhitespace: true,
        removeComments: true,
        // MINIFY=naive leaves this out, to show what happens without it (the tests do).
        ignoreCustomComments: process.env.MINIFY === 'naive' ? [] : [MNX_MARKERS],
        minifyCSS: true,
      });
    });
  }

  eleventyConfig.on('eleventy.after', ({ dir }) => {
    const out = join(here, dir.output);
    mkdirSync(join(out, 'components'), { recursive: true });
    for (const name of names) writeFileSync(join(out, 'components', `${name}.js`), check(compileFile(path(name), { emit: 'js', runtime: '@mnx/runtime' })));
    cpSync(dirname(fileURLToPath(import.meta.resolve('@mnx/runtime'))), join(out, 'vendor/mnx'), { recursive: true });
  });

  eleventyConfig.addPassthroughCopy({ public: '/' });
  return { dir: { input: '.', includes: '_includes', data: '_data', output: process.env.OUT ?? '_site' }, templateFormats: ['njk'] };
}
