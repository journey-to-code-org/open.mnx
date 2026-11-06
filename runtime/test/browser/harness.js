// Shared setup for the browser tests: builds the compiler, compiles every component in
// `components` to JavaScript, serves the runtime and the modules over HTTP, and opens pages in
// Chromium. Needs a Rust toolchain and Playwright with Chromium.
import { before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, '../../..');
const { chromium } = createRequire(import.meta.url)('playwright');

export let site;
let server, origin, browser;
const pages = new Map();

export function compiler(...args) {
  return execFileSync(join(repo, 'target/debug/mnix'), ['compile', ...args], { encoding: 'utf8' });
}

/**
 * Register setup and teardown. `components` maps module names to `.mnx` paths; `files` maps
 * extra served paths to their contents (plain modules a component imports, …).
 */
export function useBrowser(components, files = {}) {
before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  site = mkdtempSync(join(tmpdir(), 'mnx-browser-'));
  cpSync(join(here, '../../src'), join(site, 'runtime'), { recursive: true });
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(site, path), contents);
  for (const [name, path] of Object.entries(components)) {
    writeFileSync(join(site, `${name}.js`), compiler(path, '--emit', 'js'));
  }
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (pages.has(url.pathname)) {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(pages.get(url.pathname));
    }
    try {
      const body = readFileSync(join(site, url.pathname));
      response.writeHead(200, { 'content-type': extname(url.pathname) === '.js' ? 'text/javascript' : 'text/plain' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  if (site) rmSync(site, { recursive: true, force: true });
});
}

let pageCount = 0;
/** Open a page with `body`; `modules` are imported after the body is in place. */
export async function open(body, { modules = [], beforeModules = '' } = {}) {
  const path = `/page-${++pageCount}.html`;
  pages.set(path, `<!doctype html><meta charset="utf-8">
<script type="importmap">{ "imports": { "@mnx/runtime": "/runtime/index.js" } }</script>
<script>window.lifecycle = []; window.messages = [];</script>
<body>${body}</body>
<script type="module">
  ${beforeModules}
  ${modules.map((name) => `await import('/${name}.js');`).join('\n')}
  window.ready = true;
</script>`);
  const page = await browser.newPage();
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto(origin + path);
  await page.waitForFunction(() => window.ready === true);
  return { page, messages };
}

