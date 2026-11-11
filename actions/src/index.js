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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createActionsCore, routesFrom, MOUNT, SCRIPT_PATH, COOKIE } from './core.js';
import { flatName, rewriteImports, serverHalves } from './compile.js';

export { MOUNT, SCRIPT_PATH, COOKIE };

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
  const maps = [];
  for (const { path, output } of await serverHalves(root)) {
    const module = join(cacheDir, `${flatName(relative(root, path))}.server.mjs`);
    // The server half lives in the cache folder, so its relative imports point back at the source.
    writeFileSync(module, rewriteImports(output, (specifier) => pathToFileURL(resolve(dirname(path), specifier)).href));
    maps.push((await import(`${pathToFileURL(module).href}?t=${Date.now()}`)).actions);
  }
  const core = createActionsCore({ routes: routesFrom(...maps), client: CLIENT, origins, onError, context });

  /** Node's http: answers ours and returns true, or returns false without reading the body. */
  async function handle(req, res) {
    if (!req.url.startsWith(MOUNT) && !req.url.startsWith(SCRIPT_PATH)) return false;
    const response = await core.fetch(toRequest(req), { req });
    if (!response) return false;
    await send(response, res);
    return true;
  }

  return { ...core, handle };
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
