// Builds a framework example in place (output in .tmp/, not the example's dist/), serves it and
// opens it in Chromium. The examples resolve their toolchains from ../node_modules (this
// directory's package.json), so `npm install` here once covers all of them.
import { before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as playwright from 'playwright';

// MNX_BROWSER picks the engine: chromium (the default), firefox or webkit.
const launcher = playwright[process.env.MNX_BROWSER || 'chromium'];

const here = dirname(fileURLToPath(import.meta.url));
export const examples = join(here, '..');

/**
 * A known engine difference, recorded rather than failed on: when a form won't submit, Firefox
 * focuses an invalid form-associated element's validation anchor (the input inside), as the
 * other engines do, but also logs that the element is "not focusable".
 * `docs/browser-support.md` lists it.
 */
export const engineNoise = (message) => (process.env.MNX_BROWSER === 'firefox' && /[Ii]nvalid form control.* is not focusable/.test(message));
const repo = join(examples, '../..');
const out = join(examples, '.tmp');
let browser;
const servers = [];

before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  // The CLI, unless the WebAssembly build is there.
  process.env.MNX_COMPILER ??= join(repo, 'target/debug/mnx');
  // The component library the React and Vue apps import (ui/), which `npm test` builds first
  // (test/build-ui.mjs); built here only when a test file runs on its own without it.
  if (!existsSync(join(examples, 'ui/dist/package.json'))) await import('./build-ui.mjs');
  browser = await launcher.launch();
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.close();
});

/** Build `<name>/` with its own Vite config; returns the output directory. */
export async function build(name) {
  const { build } = await import('vite');
  const root = join(examples, name);
  const outDir = join(out, name);
  rmSync(outDir, { recursive: true, force: true });
  await build({ root, configFile: join(root, 'vite.config.js'), configLoader: 'native', logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  return outDir;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

/** Serve a directory over HTTP; returns its URL. */
export async function serve(dir) {
  const server = createServer((request, response) => {
    let path = join(dir, decodeURIComponent(new URL(request.url, 'http://x').pathname));
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
    let body;
    try {
      body = readFileSync(path);
    } catch {
      return response.writeHead(404).end(); // (Firefox asks for /favicon.ico)
    }
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'text/plain' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** Build, serve and open `<name>/`, collecting console messages and errors. */
export async function launch(name, options = {}) {
  const url = await serve(await build(name));
  const page = await browser.newPage(options);
  const messages = [];
  // React's development build marks its performance tracks with console.timeStamp(), which
  // Firefox reports as console messages.
  page.on('console', (message) => message.type() !== 'timeStamp' && messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto(url);
  return { page, messages, url };
}

/** Wait for pending updates: a macrotask, then every custom element's `updateComplete`. */
export const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  const all = (root) => [...root.querySelectorAll('*')].flatMap((el) => [el, ...(el.shadowRoot ? all(el.shadowRoot) : [])]);
  await Promise.all(all(document).filter((el) => el.localName.includes('-') && el.updateComplete).map((el) => el.updateComplete));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

/** Text of every match, whitespace collapsed (Playwright's CSS pierces open shadow roots). */
export const texts = (page, selector) => page.locator(selector).evaluateAll((els) => els.map((el) => el.textContent.trim().replace(/\s+/g, ' ')));
