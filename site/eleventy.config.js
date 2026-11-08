// The landing page and the documentation: node demos/build.mjs runs this over the whole Pages build, or `npm run build`
// here for the page alone (set ZUBRA_COMPILER to a native `zubra` if compiler/zubra.wasm isn't built).
//
//   OUT         where to write it (default _site)
//   BASE        the path the site is served from, like /zubra/ (default /)
//   GITHUB_REPOSITORY  who the links to the source point at (default journey-to-code-org/zubra)
//   LANDING_OUT the finished Pages build, so the page links the examples that are in it
import Prism from 'prismjs';
import loadLanguages from 'prismjs/components/index.js';

loadLanguages(['markup', 'javascript', 'bash']);

const escape = (text) => text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export default function (eleventyConfig) {
  // {{ code | highlight("html") }}: the code as markup, coloured by Prism (the colours are in landing.css).
  eleventyConfig.addFilter('highlight', (code, language = 'markup') => {
    const grammar = Prism.languages[language];
    return `<pre class="code" tabindex="0"><code class="language-${language}">${grammar ? Prism.highlight(code, grammar, language) : escape(code)}</code></pre>`;
  });
  // Compiled output keeps trailing spaces where the template had indentation; they aren't worth showing.
  // The README aligns trailing comments in a column; on a narrow pane that column wastes the room.
  eleventyConfig.addFilter('tighten', (code) => code.replace(/ {2,}(\/\/|\/\*|<!--)/g, '  $1'));
  eleventyConfig.addFilter('tidy', (code) => code.replace(/[ \t]+$/gm, ''));
  eleventyConfig.addPassthroughCopy({ 'src/assets': 'landing' });
  // The runtime the page's own component imports, as the playground serves it (no bundler).
  eleventyConfig.addPassthroughCopy({ '../runtime/src': 'landing/runtime' });
  // The docs' stylesheet and the brand files its pages show (the README's logo).
  eleventyConfig.addPassthroughCopy({ 'src/docs-assets': 'docs/assets' });
  eleventyConfig.addPassthroughCopy({ '../brand': 'docs/assets/brand' });
  // A page label may carry `code`.
  eleventyConfig.addFilter('code', (text) => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>'));
  eleventyConfig.addPassthroughCopy({ 'src/favicon.svg': 'favicon.svg' });
  eleventyConfig.addPassthroughCopy({ 'src/apple-touch-icon.png': 'apple-touch-icon.png' });

  return {
    dir: { input: 'src', output: process.env.OUT ?? '_site', includes: '_includes', data: '_data' },
    pathPrefix: process.env.BASE ?? '/',
    markdownTemplateEngine: false,
    htmlTemplateEngine: 'njk',
  };
}
