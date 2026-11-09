// @zubra/actions: serve a component's 'use server' functions, over plain form posts.
//
//   import { createActions } from '@zubra/actions';
//   const actions = await createActions({ components: 'components' });
//
//   actions.fetch(request)     // fetch-style servers (Hono, Bun, Deno): a Response, or null if not ours
//   actions.handle(req, res)   // Node's http: true if it answered
//   actions.result(request)    // after a no-JavaScript post: { action, value } once, else null
//   actions.script()           // <script> for the page: enhances those forms into fetch requests
//
// The contract (plan/actions-design.md):
// - A form posts to /_zb/action/<tag>/<name> with its own encoding; the function gets the FormData.
// - `Accept: application/json` (the enhanced path) gets the return value as JSON.
// - Anything else (the browser's own post) gets 303 See Other back to the page it came from, with
//   the return value in a one-use cookie, so the page can render it (`result()`).
// - A cross-site post is refused (Origin / Sec-Fetch-Site), so forms on other sites can't call it.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findCompiler } from '@zubra/server';

findCompiler();
const compiler = await import('@zubra/compiler');

export const MOUNT = '/_zb/action/';
export const SCRIPT_PATH = '/_zb/actions.js';
export const COOKIE = '__zb_result';
const SOURCE = /\.zb(?:\.[jt]sx)?$/;
const CLIENT = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/**
 * `context({ request, req, c })`: what else a server function gets beside `request`, per request
 * (the signed-in user, a database handle). `req` is Node's request (Node, Express, Fastify), `c`
 * Hono's context. It may be async; what it returns is spread into the function's second argument.
 *
 * `components`: the folder of `.zb` files. `cacheDir`: where the server halves are written
 * (bare imports resolve from there, so keep it inside the project). `origins`: other origins
 * allowed to post (behind a proxy that rewrites Origin, say). `onError(error, request)`: called
 * when a function throws; the client gets a generic error, never the message or stack.
 */
export async function createActions({
  components = 'components',
  cacheDir = join(process.cwd(), 'node_modules', '.cache', 'zubra-actions'),
  origins = [],
  onError = (error) => console.error(error),
  context = () => ({}),
} = {}) {
  const root = resolve(components);
  if (!existsSync(root)) throw new Error(`@zubra/actions: no components folder at ${root}`);
  mkdirSync(cacheDir, { recursive: true });

  // URL → function, from every component's server half.
  const routes = new Map();
  for (const path of sources(root)) {
    const response = compiler.request({ emit: 'server', path, files: compiler.sources(path) });
    if (!response.ok) throw new Error(response.error);
    if (!/^export (async )?function /m.test(response.output)) continue;
    const module = join(cacheDir, `${relative(root, path).split(sep).join('__').replace(SOURCE, '')}.server.mjs`);
    writeFileSync(module, absoluteImports(response.output, dirname(path)));
    const { actions } = await import(`${pathToFileURL(module).href}?t=${Date.now()}`);
    for (const [url, fn] of Object.entries(actions)) {
      if (routes.has(url)) throw new Error(`@zubra/actions: two components define ${url}`);
      routes.set(url, fn);
    }
  }

  const allowed = (request) => {
    const site = request.headers.get('sec-fetch-site');
    if (site) return site === 'same-origin' || site === 'none';
    const origin = request.headers.get('origin');
    if (!origin) return true; // not a browser (curl, a test): CSRF needs a browser
    return origin === new URL(request.url).origin || origins.includes(origin);
  };

  /** The page to go back to: the referring page on this origin, else the site root. */
  const back = (request) => {
    const referer = request.headers.get('referer');
    try {
      const url = new URL(referer, request.url);
      if (url.origin === new URL(request.url).origin) return url.pathname + url.search;
    } catch {}
    return '/';
  };

  async function fetch(request, extra = {}) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === SCRIPT_PATH) {
      return new Response(CLIENT, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    }
    if (!url.pathname.startsWith(MOUNT)) return null;
    if (request.method !== 'POST') return text(405, 'Method Not Allowed', { allow: 'POST' });
    if (!allowed(request)) return text(403, 'Cross-site form posts are refused');
    const fn = routes.get(url.pathname);
    if (!fn) return text(404, 'Not Found');
    const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
    let value;
    let failed = false;
    try {
      const more = await context({ request, ...extra });
      value = await fn(await request.formData(), { ...more, request });
    } catch (error) {
      onError(error, request);
      failed = true;
      value = { error: 'Something went wrong' };
    }
    if (value instanceof Response) return value;
    if (wantsJson) {
      return new Response(JSON.stringify(value ?? null), {
        status: failed ? 500 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const headers = new Headers({ location: back(request) });
    const cookie = encodeURIComponent(JSON.stringify({ action: url.pathname, value: value ?? null }));
    // A cookie holds about 4 KB; a bigger result reaches only the enhanced path.
    if (cookie.length < 3800) {
      headers.append('set-cookie', `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
    }
    return new Response(null, { status: 303, headers });
  }

  /**
   * After a no-JavaScript post: `{ action, value }` once, else null. `request` is a fetch Request
   * or a Node request; `setHeader(name, value)` is given the header that clears the cookie.
   */
  function result(request, setHeader) {
    const header = (typeof request.headers.get === 'function' ? request.headers.get('cookie') : request.headers.cookie) ?? '';
    const match = header.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
    if (!match) return null;
    setHeader?.('set-cookie', CLEAR);
    try {
      return JSON.parse(decodeURIComponent(match.slice(COOKIE.length + 1)));
    } catch {
      return null;
    }
  }

  /** Node's http: answers ours and returns true, or returns false without reading the body. */
  async function handle(req, res) {
    if (!req.url.startsWith(MOUNT) && !req.url.startsWith(SCRIPT_PATH)) return false;
    const response = await fetch(toRequest(req), { req });
    if (!response) return false;
    await send(response, res);
    return true;
  }

  return {
    fetch,
    handle,
    result,
    routes: () => [...routes.keys()],
    script: () => `<script type="module" src="${SCRIPT_PATH}"></script>`,
    clearCookie: CLEAR,
  };
}

const CLEAR = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

function text(status, body, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}

function sources(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && !entry.startsWith('.')) sources(path, out);
    } else if (SOURCE.test(entry)) out.push(path);
  }
  return out;
}

/** The server half lives in the cache folder, so its relative imports point back at the source. */
function absoluteImports(code, from) {
  return code.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, keyword, quote, specifier) =>
    `${keyword}${quote}${pathToFileURL(resolve(from, specifier)).href}${quote}`);
}

/** A Node request as a fetch Request (the body streams; nothing is read until it's ours). */
export function toRequest(req) {
  const host = req.headers.host ?? 'localhost';
  const protocol = req.socket?.encrypted ? 'https' : 'http';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((each) => headers.append(name, each));
    else if (value !== undefined) headers.set(name, value);
  }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : req;
  return new Request(`${protocol}://${host}${req.url}`, { method: req.method, headers, body, duplex: 'half' });
}

/** Write a fetch Response to a Node response. */
export async function send(response, res) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') continue;
    res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}
