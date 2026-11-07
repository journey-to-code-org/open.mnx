// Eleventy with mnx (through @mnx/server), and no bundler:
//
// - `{% mnx "trail-card", { … } %}` renders a component to HTML at build time.
// - A transform finishes each page: the CSS of the components it used in its head, and their
//   modules at the end of its body.
// - After the build, `writeAssets()` writes the components' browser modules and @mnx/runtime to
//   _site/_mnx/.
//
// MINIFY=1 minifies the HTML, keeping mnx's hydration markers (they're comments: see below).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMnx } from '@mnx/server';
import { MNX_MARKER_COMMENT } from '@mnx/compiler';

const here = dirname(fileURLToPath(import.meta.url));
const mnx = createMnx({ components: join(here, 'components') });

export default function (eleventyConfig) {
  const pages = new Map(); // page URL → its mnx page (what it rendered)
  const pageFor = (url) => {
    if (!pages.has(url)) pages.set(url, mnx.page());
    return pages.get(url);
  };

  eleventyConfig.addShortcode('mnx', function (name, props = {}) {
    return pageFor(this.page?.url).render(name, props);
  });

  eleventyConfig.addTransform('mnx', function (html) {
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
        // mnx's hydration markers are comments: keep them, or the elements render afresh
        // instead of hydrating. (MINIFY=naive leaves this out, to show that; the tests do.)
        ignoreCustomComments: process.env.MINIFY === 'naive' ? [] : [MNX_MARKER_COMMENT],
        minifyCSS: true,
      });
    });
  }

  eleventyConfig.on('eleventy.after', ({ dir }) => mnx.writeAssets(join(here, dir.output)));

  eleventyConfig.addPassthroughCopy({ public: '/' });
  return { dir: { input: '.', includes: '_includes', data: '_data', output: process.env.OUT ?? '_site' }, templateFormats: ['njk'] };
}
