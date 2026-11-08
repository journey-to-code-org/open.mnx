// Eleventy with zubra (through @zubra/server), and no bundler:
//
// - `{% zubra "trail-card", { … } %}` renders a component to HTML at build time.
// - A transform finishes each page: the CSS of the components it used in its head, and their
//   modules at the end of its body.
// - After the build, `writeAssets()` writes the components' browser modules and @zubra/runtime to
//   _site/_zubra/.
//
// MINIFY=1 minifies the HTML. zubra's hydration markers are processing instructions (`<?zb [?>`),
// which minifiers keep: nothing to configure.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';

const here = dirname(fileURLToPath(import.meta.url));
const zubra = createZubra({ components: join(here, 'components') });

export default function (eleventyConfig) {
  const pages = new Map(); // page URL → its zubra page (what it rendered)
  const pageFor = (url) => {
    if (!pages.has(url)) pages.set(url, zubra.page());
    return pages.get(url);
  };

  eleventyConfig.addShortcode('zubra', function (name, props = {}) {
    return pageFor(this.page?.url).render(name, props);
  });

  eleventyConfig.addTransform('zubra', function (html) {
    if (!this.page.outputPath?.endsWith('.html') || !pages.has(this.page.url)) return html;
    return pages.get(this.page.url).finish(html);
  });

  if (process.env.MINIFY) {
    eleventyConfig.addTransform('minify', async function (html) {
      if (!this.page.outputPath?.endsWith('.html')) return html;
      const { minify } = await import('html-minifier-terser');
      return minify(html, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
      });
    });
  }

  // DEMO_BASE: the path the site is served under (the demo gallery's /<repo>/demos/eleventy-trails/).
  // Root-relative URLs, the components' modules and the import map are moved under it.
  const demoBase = process.env.DEMO_BASE;
  if (demoBase) {
    eleventyConfig.addTransform('demo-base', function (html) {
      if (!this.page.outputPath?.endsWith('.html')) return html;
      return html.replace(/(href|src)="\/(?!\/)/g, `$1="${demoBase}`).replace(/(["'])\/_zubra\//g, `$1${demoBase}_zubra/`);
    });
  }

  eleventyConfig.on('eleventy.after', ({ dir }) => zubra.writeAssets(resolve(here, dir.output)));

  eleventyConfig.addPassthroughCopy({ public: '/' });
  return { dir: { input: '.', includes: '_includes', data: '_data', output: process.env.OUT ?? '_site' }, templateFormats: ['njk'] };
}
