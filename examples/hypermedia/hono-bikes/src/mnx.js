// mnx for a Hono app: render components to HTML for a page or an htmx fragment, and serve
// their browser modules and @mnx/runtime. Plain files and @mnx/compiler, so it runs the same on
// Node.js and Bun.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFile, request, sources } from '@mnx/compiler';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, '../../../..');
export const COMPONENTS = join(here, '../components');
const runtimeDir = dirname(fileURLToPath(import.meta.resolve('@mnx/runtime')));

// Inside this repository, the CLI from `cargo build` stands in for @mnx/compiler's WebAssembly
// build (see examples/helpdesk/src/compiler.js for the whole story).
if (!process.env.MNX_COMPILER) {
  const cli = ['debug', 'release'].map((profile) => join(repo, 'target', profile, `mnx${process.platform === 'win32' ? '.exe' : ''}`)).find(existsSync);
  if (cli) process.env.MNX_COMPILER = cli;
}

const names = readdirSync(COMPONENTS).filter((file) => file.endsWith('.mnx')).map((file) => file.slice(0, -4));
const check = (response) => {
  if (!response.ok) throw new Error(response.error);
  return response.output;
};

export function createMnx({ cache = true } = {}) {
  const memo = new Map();
  const once = (key, make) => {
    if (!cache || !memo.has(key)) memo.set(key, make());
    return memo.get(key);
  };
  const path = (name) => join(COMPONENTS, `${name}.mnx`);
  const files = (name) => once(`files:${name}`, () => sources(path(name)));

  /** A component's HTML (a string). */
  function render(name, props = {}, slots = {}) {
    if (!names.includes(name)) throw new Error(`no component ${name}`);
    return check(request({ emit: 'html', path: path(name), files: files(name), props, slots, slotSource: 'html', partial: true }));
  }

  // Every component's CSS, once, for the layout: htmx fragments bring in components the first
  // page may not have used, so the page has them all (they're small).
  const css = () => once('css', () => names.map((name) => check(request({ emit: 'css', path: path(name), files: files(name) }))).join('\n'));
  const js = (name) => once(`js:${name}`, () => check(compileFile(path(name), { emit: 'js', runtime: '@mnx/runtime' })));

  /** Hono routes for the browser's modules. */
  function routes(app) {
    app.get('/components/:file{.+\\.js}', (c) => {
      const name = c.req.param('file').slice(0, -3);
      if (!names.includes(name)) return c.notFound();
      return c.body(js(name), 200, { 'content-type': 'text/javascript' });
    });
    app.get('/vendor/mnx/:file{.+\\.js}', (c) => {
      const file = join(runtimeDir, c.req.param('file'));
      if (!file.startsWith(runtimeDir) || !existsSync(file)) return c.notFound();
      return c.body(readFileSync(file, 'utf8'), 200, { 'content-type': 'text/javascript' });
    });
  }
  return { render, css, routes, names };
}
