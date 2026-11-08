// Builds the documentation site: the Markdown in docs/, plus the README (the reference) and the
// CHANGELOG, rendered to plain HTML with a sidebar. GitHub Pages serves it at <base>docs/.
//
//   node docs/site/build.mjs [--out _site] [--base /zubra/]
//
// demos/build.mjs runs it as part of the Pages build. Needs `npm ci` in docs/site (it installs
// marked, the only dependency).
//
// A relative link in a page is rewritten to the page it names. A link to a file that isn't part of
// the site (source code, an example's folder) goes to that file on GitHub, and a link to something
// that doesn't exist fails the build, so a moved file can't leave a dead link behind.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');

/** The navigation: each group is a heading in the sidebar. `file` is a path from the repository root. */
export const nav = [
  { group: 'Guide', pages: [
    { file: 'docs/guide/README.md', slug: '', label: 'Overview' },
    { file: 'docs/guide/01-first-component.md', label: 'Your first component' },
    { file: 'docs/guide/02-templates.md', label: 'Templates' },
    { file: 'docs/guide/03-props-and-events.md', label: 'Two-way props and events' },
    { file: 'docs/guide/04-composition.md', label: 'Composition and slots' },
    { file: 'docs/guide/05-forms.md', label: 'Forms' },
    { file: 'docs/guide/06-async-data.md', label: 'Async data' },
    { file: 'docs/guide/07-server-rendering.md', label: 'Server rendering' },
    { file: 'docs/guide/08-read-the-output.md', label: 'Read the output' },
  ] },
  { group: 'Coming from a framework', pages: [
    { file: 'docs/guide/for-react-developers.md', label: 'React developers' },
    { file: 'docs/guide/for-vue-developers.md', label: 'Vue developers' },
    { file: 'docs/guide/for-svelte-developers.md', label: 'Svelte developers' },
  ] },
  { group: 'Topics', pages: [
    { file: 'docs/who-this-is-for.md', label: 'Who Zubra is for' },
    { file: 'docs/what-crosses-the-boundary.md', label: 'What crosses the boundary' },
    { file: 'docs/server-rendering.md', label: 'Server rendering, honestly' },
    { file: 'docs/guide/other-peoples-pages.md', label: 'On other people’s pages' },
    { file: 'docs/guide/accessible-widgets.md', label: 'Accessible widgets' },
    { file: 'docs/guide/styling-libraries.md', label: 'Styling libraries' },
  ] },
  { group: 'Reference', pages: [
    { file: 'README.md', slug: 'reference', label: 'Reference (the README)' },
    { file: 'docs/browser-support.md', label: 'Browser support' },
    { file: 'docs/security.md', label: 'Security model' },
    { file: 'docs/framework-matrix.md', label: 'The framework matrix' },
    { file: 'docs/convert-measured.md', label: '`zubra convert`, measured' },
    { file: 'CHANGELOG.md', slug: 'changelog', label: 'Changelog' },
  ] },
  { group: 'Migrating', pages: [
    { file: 'docs/migrating-to-5.0.md', label: 'To 5.0' },
    { file: 'docs/migrating-to-4.0.md', label: 'To 4.0 (mnx is now Zubra)' },
    { file: 'docs/migrating-to-3.0.md', label: 'To 3.0' },
    { file: 'docs/migrating-to-2.0.md', label: 'To 2.0' },
    { file: 'docs/migrating-from-0.2.md', label: 'From 0.2' },
  ] },
  { group: 'Standards reports', pages: [
    { file: 'docs/standards/declarative-custom-elements.md', label: 'Declarative custom elements' },
    { file: 'docs/standards/dom-parts.md', label: 'DOM Parts' },
    { file: 'docs/standards/signals.md', label: 'Signals' },
    { file: 'docs/standards/one-source-n-consumers.md', label: 'One source, N consumers' },
  ] },
];

/** The mark (brand/zubra-mark.svg), inline so it takes the page's colours. */
const mark = '<svg class="mark" viewBox="0 0 96 96" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10 15 a5 5 0 0 1 5 -5 H81 a5 5 0 0 1 5 5 V27 H10 Z"/><path fill="currentColor" d="M10 69 H86 V81 a5 5 0 0 1 -5 5 H15 a5 5 0 0 1 -5 -5 Z"/><path fill="var(--accent)" d="M54 27 H86 L42 69 H10 Z"/></svg>';

/** Where a page lives under <base>docs/: docs/guide/x.md → guide/x/, README.md → reference/ (by `slug`). */
const slugOf = (page) => page.slug ?? page.file.replace(/^docs\//, '').replace(/\.md$/, '');

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const plain = (html) => html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
/** GitHub's heading anchors: lower case, punctuation removed, spaces to hyphens. */
export const anchor = (text) => plain(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

export function buildDocs({ out, base, repository = 'journey-to-code-org/zubra' }) {
  const github = `https://github.com/${repository}`;
  const pages = nav.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.group, slug: slugOf(page) })));
  const bySource = new Map(pages.map((page) => [page.file, page]));
  const urlOf = (page) => `${base}docs/${page.slug ? `${page.slug}/` : ''}`;
  const version = JSON.parse(readFileSync(join(repo, 'runtime/package.json'), 'utf8')).version;

  /** Where a link written in `from` (a repository path) should go. */
  function target(from, href) {
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href) || href.startsWith('#')) return href;
    const [path, hash = ''] = href.split(/(?=#)/);
    const resolved = posix.normalize(posix.join(posix.dirname(from), decodeURI(path)));
    const page = bySource.get(resolved);
    if (page) return `${urlOf(page)}${hash}`;
    const absolute = join(repo, resolved);
    if (!existsSync(absolute)) throw new Error(`docs: ${from}: the link "${href}" points to ${resolved}, which doesn't exist`);
    return `${github}/${statSync(absolute).isDirectory() ? 'tree' : 'blob'}/main/${resolved.replace(/\/$/, '')}${hash}`;
  }

  function render(page) {
    const seen = new Map();
    const marked = new Marked({
      gfm: true,
      renderer: {
        heading({ tokens, depth }) {
          const inner = this.parser.parseInline(tokens);
          const base = anchor(inner);
          const count = seen.get(base) ?? 0;
          seen.set(base, count + 1);
          const id = count ? `${base}-${count}` : base;
          return `<h${depth} id="${escape(id)}">${inner}<a class="anchor" href="#${escape(id)}" aria-label="Link to this section">#</a></h${depth}>\n`;
        },
        link({ href, title, tokens }) {
          const inner = this.parser.parseInline(tokens);
          return `<a href="${escape(target(page.file, href))}"${title ? ` title="${escape(title)}"` : ''}>${inner}</a>`;
        },
        image({ href, title, text }) {
          const src = /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)
            ? href
            : `https://raw.githubusercontent.com/${repository}/main/${posix.normalize(posix.join(posix.dirname(page.file), href))}`;
          return `<img src="${escape(src)}" alt="${escape(text)}"${title ? ` title="${escape(title)}"` : ''} loading="lazy">`;
        },
      },
    });
    return marked.parse(readFileSync(join(repo, page.file), 'utf8'));
  }

  const sidebar = (current) => `<nav class="side" id="docs-nav" aria-label="Documentation">
${nav.map((group) => `  <h2>${escape(group.group)}</h2>
  <ul>
${group.pages.map((entry) => {
    const page = bySource.get(entry.file);
    return `    <li><a href="${urlOf(page)}"${page === current ? ' aria-current="page"' : ''}>${escape(page.label).replace(/`([^`]+)`/g, '<code>$1</code>')}</a></li>`;
  }).join('\n')}
  </ul>`).join('\n')}
</nav>`;

  const guide = nav[0].pages.map((entry) => bySource.get(entry.file));
  function pager(page) {
    const at = guide.indexOf(page);
    if (at < 0) return '';
    const link = (other, rel, text) => (other ? `<a rel="${rel}" href="${urlOf(other)}"><span>${text}</span>${escape(other.label)}</a>` : '<span></span>');
    return `<nav class="pager" aria-label="Guide pages">${link(guide[at - 1], 'prev', 'Previous')}${link(guide[at + 1], 'next', 'Next')}</nav>`;
  }

  const document = (page, body) => {
    const title = plain(body.match(/<h1[^>]*>([\s\S]*?)<a class="anchor"/)?.[1] ?? page.label);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · Zubra docs</title>
  <meta name="description" content="Zubra compiles HTML-first components into standard web components. Documentation: the guide, topics, reference and migration notes.">
  <link rel="stylesheet" href="${base}docs/assets/site.css">
</head>
<body>
  <a class="skip" href="#content">Skip to the content</a>
  <header class="top">
    <a class="brand" href="${base}docs/">${mark}Zubra <span>docs</span></a>
    <nav aria-label="Site">
      <a class="all-pages" href="#docs-nav">All pages</a>
      <a href="${base}playground/">Playground</a>
      <a href="${base}">Demos</a>
      <a href="${github}">GitHub</a>
    </nav>
  </header>
  <div class="layout">
    ${sidebar(page)}
    <main id="content">
      <article class="doc">
${body}
      </article>
      ${pager(page)}
      <p class="edit"><a href="${github}/blob/main/${page.file}">Edit this page on GitHub</a> · Zubra ${escape(version)}</p>
    </main>
  </div>
</body>
</html>
`;
  };

  const root = join(out, 'docs');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets/site.css'), readFileSync(join(here, 'site.css')));
  for (const page of pages) {
    const dir = join(root, page.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), document(page, render(page)));
  }
  return pages.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const repository = process.env.GITHUB_REPOSITORY;
  const base = option('--base', process.env.GITHUB_ACTIONS && repository ? `/${repository.split('/')[1]}/` : '/');
  if (!base.startsWith('/') || !base.endsWith('/')) throw new Error(`docs: --base must start and end with / (got ${base})`);
  const out = resolve(option('--out', join(repo, '_site')));
  const count = buildDocs({ out, base, repository });
  console.log(`docs: ${count} pages → ${join(out, 'docs')} (served from ${base}docs/)`);
}
