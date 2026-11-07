// Shared by the tests that build the projects in examples/ and use them in Chromium. Each project
// is copied inside plugin/ so it resolves its packages from here (its own package.json points at
// the repository's packages), next to a link to the plugin itself, as `npm install` would give.
import { before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, '../..');
const { chromium } = createRequire(import.meta.url)('playwright');
let browser;
const servers = [];

/** Register the setup and cleanup for a test file; `name` names its working directory. */
export function useExamples(name) {
  const work = join(here, `.tmp-${name}`);
  before(async () => {
    execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
    // The CLI, unless the WebAssembly build is there.
    process.env.MNX_COMPILER ??= join(repo, 'target/debug/mnx');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, 'node_modules/@mnx'), { recursive: true });
    symlinkSync(join(here, '..'), join(work, 'node_modules/@mnx/unplugin'), 'dir');
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const server of servers) server.close();
    rmSync(work, { recursive: true, force: true });
  });
  return {
    /** Copy `examples/<path>` into the working directory; returns the copy's root. */
    copy(path) {
      const root = join(work, path.replaceAll('/', '-'));
      cpSync(join(repo, 'examples', path), root, { recursive: true, filter: (file) => !/[\\/](node_modules|dist|\.astro|\.angular)([\\/]|$)/.test(file) });
      return root;
    },
  };
}

/** Build a Vite project with its own config. */
export async function buildVite(root) {
  const { build } = await import('vite');
  await build({ root, configFile: join(root, 'vite.config.js'), configLoader: 'native', logLevel: 'silent' });
  return join(root, 'dist');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

/** Serve a directory over HTTP; returns its URL. */
export async function serve(dir) {
  const server = createServer((request, response) => {
    let path = join(dir, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    try {
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain' }).end(readFileSync(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** Open a page, collecting console messages and errors. */
export async function open(url, options = {}) {
  const page = await browser.newPage(options);
  const messages = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto(url);
  return { page, messages };
}

/** Wait for pending updates: a macrotask, then every custom element's `updateComplete`. */
export const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const all = (root) => [...root.querySelectorAll('*')].flatMap((el) => [el, ...(el.shadowRoot ? all(el.shadowRoot) : [])]);
  await Promise.all(all(document).filter((el) => el.localName.includes('-') && el.updateComplete).map((el) => el.updateComplete));
});

/** Text of every match, whitespace collapsed. Pierces open shadow roots (Playwright CSS does). */
export const texts = (page, selector) => page.locator(selector).evaluateAll((els) => els.map((el) => el.textContent.trim().replace(/\s+/g, ' ')));
