// The documentation site in the built gallery (docs/site/build.mjs), read as files, with no browser:
// every page of the navigation is built, every link on every page lands on a page or an anchor
// that exists under the base path, and Markdown links didn't survive as links to `.md` files.
//
//   node demos/build.mjs --out _site --base /zubra/ && node --test "demos/test/docs.test.js"
//
// GALLERY (default _site) and GALLERY_BASE (default /zubra/) say where the build is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nav } from '../../docs/site/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../..', process.env.GALLERY ?? '_site');
const base = process.env.GALLERY_BASE ?? '/zubra/';
const files = nav.flatMap((group) => group.pages.map((page) => page.file));
const slug = (page) => page.slug ?? page.file.replace(/^docs\//, '').replace(/\.md$/, '');
const pages = nav.flatMap((group) => group.pages.map((page) => ({ ...page, path: join(dir, 'docs', slug(page), 'index.html') })));

const html = (path) => readFileSync(path, 'utf8');
const ids = (page) => new Set([...html(page).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
/** The file a URL under the base path is served from, or null for one that isn't ours. */
const fileFor = (url) => {
  if (!url.startsWith(base)) return null;
  const path = join(dir, url.slice(base.length));
  return url.endsWith('/') ? join(path, 'index.html') : path;
};

test('every page of the navigation is built', () => {
  assert.ok(existsSync(join(dir, 'docs/index.html')), `no docs in ${dir}: run node demos/build.mjs --out ${dir} --base ${base}`);
  assert.equal(pages.length, files.length);
  for (const page of pages) assert.ok(existsSync(page.path), `${page.file} isn't built (${page.path})`);
  assert.match(html(join(dir, 'docs/guide/08-read-the-output/index.html')), /<h1[^>]*>8\. Read the output/);
});

test('every page lists every other page in its sidebar and marks its own', () => {
  for (const page of pages) {
    const source = html(page.path);
    assert.equal((source.match(/aria-current="page"/g) ?? []).length, 1, `${page.file} marks one current page`);
    for (const other of pages) {
      const href = `${base}docs/${slug(other) ? `${slug(other)}/` : ''}`;
      assert.ok(source.includes(`href="${href}"`), `${page.file} links to ${href}`);
    }
  }
});

test('every internal link and anchor resolves', () => {
  let checked = 0;
  for (const page of pages) {
    for (const [, href] of html(page.path).matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const url = href.replace(/&amp;/g, '&');
      if (/^(https?:|mailto:)/.test(url)) continue;
      assert.doesNotMatch(url, /\.md(#|$)/, `${page.file}: "${url}" is a link to a Markdown file`);
      const [path, hash] = url.split('#');
      const target = path ? fileFor(path) : page.path;
      assert.ok(target, `${page.file}: "${url}" isn't under ${base}`);
      assert.ok(existsSync(target), `${page.file}: "${url}" has no file (${target})`);
      if (hash) assert.ok(ids(target).has(decodeURIComponent(hash)), `${page.file}: "${url}" has no such anchor`);
      checked += 1;
    }
  }
  assert.ok(checked > 500, `${checked} links checked: fewer than expected`);
});
