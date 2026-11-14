// Builds a host with one implementation (output in .tmp/), serves it and opens it in Chromium.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { config } from '../hosts/config.mjs';

export const here = fileURLToPath(new URL('..', import.meta.url));

let browser;
const servers = [];
export const launchBrowser = async () => {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ channel: 'chrome' }); // no Playwright Chromium downloaded: the system's Chrome
  }
};
/** Close the browser and the servers: `after(cleanup)` in each test file. */
export async function cleanup() {
  await browser?.close();
  for (const server of servers) server.close();
}

/** Build hosts/<host> against impl/<impl>; returns the output directory. */
export async function build(host, impl) {
  const { build } = await import('vite');
  const outDir = join(here, '.tmp', `${impl}-${host}`);
  rmSync(outDir, { recursive: true, force: true });
  await build({ ...(await config(host, impl)), configFile: false, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  return outDir;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

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

/** Open a URL, collecting console errors and page errors. */
export async function open(url, options = {}) {
  browser ??= await launchBrowser();
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon/.test(message.text())) problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  await page.goto(url);
  return { page, problems, close: () => context.close() };
}
