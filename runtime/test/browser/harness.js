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
// ZUBRA_BROWSER picks the engine: chromium (the default), firefox or webkit.
export const engine = process.env.ZUBRA_BROWSER || 'chromium';
const launcher = createRequire(import.meta.url)('playwright')[engine];

export let site;
export const production = process.env.ZUBRA_RUNTIME === 'production';
let server, origin, browser;
const pages = new Map();

export function compiler(...args) {
  return execFileSync(join(repo, 'target/debug/zubra'), ['compile', ...args], { encoding: 'utf8' });
}

// ZUBRA_EMIT=element compiles each component as a plain custom element (`--emit element`), so a
// suite runs on both outputs; a component it refuses (shadow DOM, Zag…) stays on `--emit js`, and
// `elementRefused` says which and why.
export const emitElement = process.env.ZUBRA_EMIT === 'element';
export const elementRefused = new Map();
/** Skips a test of what only @zubra/runtime does (server hydration, hot reload) on --emit element output. */
export const runtimeOnly = emitElement && '--emit element output has no server hydration or hot reload: these stay on @zubra/runtime';
function compile(path) {
  if (!emitElement) return compiler(path, '--emit', 'js');
  try {
    return execFileSync(join(repo, 'target/debug/zubra'), ['compile', path, '--emit', 'element'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    elementRefused.set(path, String(error.stderr).split('\n').find((line) => line.startsWith('error')) ?? 'refused');
    return compiler(path, '--emit', 'js');
  }
}

/**
 * Register setup and teardown. `components` maps module names to `.zb` paths; `files` maps
 * extra served paths to their contents (plain modules a component imports, …; or a function
 * returning them, called after the compiler is built); `imports` adds
 * to the pages' import map (bare specifiers for those modules).
 */
export function useBrowser(components, files = {}, imports = {}) {
extraImports = imports;
before(async () => {
  execFileSync('cargo', ['build', '--quiet'], { cwd: repo, stdio: 'inherit' });
  site = mkdtempSync(join(tmpdir(), 'zb-browser-'));
  // ZUBRA_RUNTIME=production runs the suite against the production build (no hot reloading).
  cpSync(join(here, production ? '../../dist/production' : '../../src'), join(site, 'runtime'), { recursive: true });
  // (A function is called once the compiler is built: a module compiled with other flags.)
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(site, path), typeof contents === 'function' ? contents() : contents);
  for (const [name, path] of Object.entries(components)) {
    writeFileSync(join(site, `${name}.js`), compile(path));
  }
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (pages.has(url.pathname)) {
      response.writeHead(200, { 'content-type': 'text/html' });
      return response.end(pages.get(url.pathname));
    }
    try {
      const body = readFileSync(join(site, url.pathname));
      response.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css' }[extname(url.pathname)] ?? 'text/plain' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launcher.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  if (site) rmSync(site, { recursive: true, force: true });
});
}

let pageCount = 0;
let extraImports = {};
/** Open a page with `body`; `modules` are imported after the body is in place. */
export async function open(body, { modules = [], beforeModules = '' } = {}) {
  const path = `/page-${++pageCount}.html`;
  pages.set(path, `<!doctype html><meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: { '@zubra/runtime': '/runtime/index.js', '@zubra/runtime/spread': '/runtime/spread.js', '@zubra/runtime/primitives': '/runtime/primitives.js', '@zubra/runtime/motion': '/runtime/motion.js', ...extraImports } })}</script>
<script>window.lifecycle = []; window.messages = [];</script>
<body>${body}</body>
<script type="module">
  ${beforeModules}
  ${modules.map((name) => `await import('/${name}.js');`).join('\n')}
  window.ready = true;
</script>`);
  const page = await browser.newPage();
  const messages = [];
  // React's development build marks its performance tracks with console.timeStamp(), which
  // Firefox reports as console messages.
  page.on('console', (message) => message.type() !== 'timeStamp' && messages.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto(origin + path);
  try {
    await page.waitForFunction(() => window.ready === true, null, { timeout: 15000 });
  } catch (error) {
    // Say why: a module that didn't load usually logged it.
    throw new Error(`the page didn't start: ${messages.join(' | ') || error.message}`);
  }
  return { page, messages };
}

