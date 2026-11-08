// The documentation: the Markdown in docs/, plus the README (the reference) and the CHANGELOG, rendered
// to HTML here and laid out by docs.njk, one page per entry of nav.js. GitHub Pages serves it at <base>docs/.
//
// A relative link in a page is rewritten to the page it names. A link to a file that isn't part of the
// site (source code, an example's folder) goes to that file on GitHub, and a link to something that
// doesn't exist fails the build, so a moved file can't leave a dead link behind. Images: brand/ is
// copied into the site (docs/assets/brand/), any other is read from the repository on GitHub.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import Prism from 'prismjs';
import loadLanguages from 'prismjs/components/index.js';
import nav from './nav.js';

loadLanguages(['markup', 'css', 'javascript', 'jsx', 'typescript', 'tsx', 'bash', 'diff']);
// A fence's language, as Prism names it. `.zb` is HTML with braces, which Prism's markup grammar colours well enough.
const GRAMMAR = { html: 'markup', zb: 'markup', vue: 'markup', svelte: 'markup', sh: 'bash', js: 'javascript', ts: 'typescript' };
const colour = (code, language) => {
  const name = GRAMMAR[language] ?? language;
  return Prism.languages[name] ? Prism.highlight(code, Prism.languages[name], name) : '';
};

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const base = process.env.BASE ?? '/';
const repository = process.env.GITHUB_REPOSITORY ?? 'journey-to-code-org/zubra';
const github = `https://github.com/${repository}`;

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const plain = (html) => html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
/** GitHub's heading anchors: lower case, punctuation removed, spaces to hyphens. */
const anchor = (text) => plain(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const absolute = (href) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href);

/** Where a page lives under <base>docs/: docs/guide/x.md → guide/x/, README.md → reference/ (by `slug`). */
const slugOf = (page) => page.slug ?? page.file.replace(/^docs\//, '').replace(/\.md$/, '');

const pages = nav.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.group, slug: slugOf(page) })));
const bySource = new Map(pages.map((page) => [page.file, page]));
const urlOf = (page) => `${base}docs/${page.slug ? `${page.slug}/` : ''}`;

/** Where a link written in `from` (a repository path) should go. */
function target(from, href) {
  if (absolute(href) || href.startsWith('#')) return href;
  const [path, hash = ''] = href.split(/(?=#)/);
  const resolved = posix.normalize(posix.join(posix.dirname(from), decodeURI(path)));
  const page = bySource.get(resolved);
  if (page) return `${urlOf(page)}${hash}`;
  const file = join(repo, resolved);
  if (!existsSync(file)) throw new Error(`docs: ${from}: the link "${href}" points to ${resolved}, which doesn't exist`);
  return `${github}/${statSync(file).isDirectory() ? 'tree' : 'blob'}/main/${resolved.replace(/\/$/, '')}${hash}`;
}

/** Where an image written in `from` is served. */
function imageUrl(from, href) {
  if (absolute(href) || href.startsWith('data:')) return href;
  const resolved = posix.normalize(posix.join(posix.dirname(from), decodeURI(href)));
  if (!existsSync(join(repo, resolved))) throw new Error(`docs: ${from}: the image "${href}" points to ${resolved}, which doesn't exist`);
  return resolved.startsWith('brand/') ? `${base}docs/assets/${resolved}` : `https://raw.githubusercontent.com/${repository}/main/${resolved}`;
}

/** Markdown to HTML for one page: heading ids and anchors, and every relative link and image rewritten. */
function render(page) {
  const md = new MarkdownIt({ html: true, linkify: true, });
  md.core.ruler.push('zubra-docs', (state) => {
    const seen = new Map();
    state.tokens.forEach((token, at) => {
      if (token.type === 'heading_open') {
        const inline = state.tokens[at + 1];
        const slug = anchor(md.renderer.renderInline(inline.children, md.options, state.env));
        const count = seen.get(slug) ?? 0;
        seen.set(slug, count + 1);
        const id = count ? `${slug}-${count}` : slug;
        token.attrSet('id', id);
        const link = new state.Token('html_inline', '', 0);
        link.content = `<a class="anchor" href="#${escape(id)}" aria-label="Link to this section">#</a>`;
        inline.children.push(link);
      }
      for (const child of token.children ?? [token]) {
        if (child.type === 'link_open') child.attrSet('href', target(page.file, child.attrGet('href')));
        else if (child.type === 'image') {
          child.attrSet('src', imageUrl(page.file, child.attrGet('src')));
          child.attrSet('loading', 'lazy');
        } else if (child.type === 'html_block' || child.type === 'html_inline') {
          // Markup written in the Markdown (the README's logo, its <details>): the same treatment.
          child.content = child.content
            .replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/g, (_, open, src, close) => open + escape(imageUrl(page.file, src)) + close)
            .replace(/(<a\b[^>]*?\shref=")([^"]+)(")/g, (_, open, href, close) => open + escape(target(page.file, href)) + close);
        }
      }
    });
  });
  return md.render(readFileSync(join(repo, page.file), 'utf8'));
}

const guide = nav[0].pages.map((entry) => bySource.get(entry.file));
const rendered = pages.map((page) => {
  const html = render(page);
  const guideAt = guide.indexOf(page);
  return {
    ...page,
    url: urlOf(page),
    html,
    title: plain(html.match(/<h1[^>]*>([\s\S]*?)<a class="anchor"/)?.[1] ?? page.label),
    prev: guideAt > 0 ? { url: urlOf(guide[guideAt - 1]), label: guide[guideAt - 1].label } : null,
    next: guideAt >= 0 && guideAt < guide.length - 1 ? { url: urlOf(guide[guideAt + 1]), label: guide[guideAt + 1].label } : null,
  };
});

export default {
  pages: rendered,
  nav: nav.map((group) => ({ group: group.group, pages: group.pages.map((entry) => rendered[pages.indexOf(bySource.get(entry.file))]) })),
  version: JSON.parse(readFileSync(join(repo, 'runtime/package.json'), 'utf8')).version,
  github,
};
