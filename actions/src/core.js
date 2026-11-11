// What @zubra/actions does with a request, given its routes: no file system, no Node.js. The Node
// entry (index.js) compiles a components folder into routes when it starts; the edge entry
// (edge.js) is given routes built ahead of time (`zubra-actions build`). Both answer through this.
export const MOUNT = '/_zb/action/';
export const SCRIPT_PATH = '/_zb/actions.js';
export const COOKIE = '__zb_result';
export const CLEAR = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
/** The largest post read by default: 10 MB, files and fields together. */
export const MAX_BYTES = 10 * 1024 * 1024;
/** What a function's caller gets for a post over the limit; the function doesn't run. */
export const TOO_LARGE = Object.freeze({ error: 'Too large' });

/**
 * `routes`: a Map of URL → function. `client`: the enhancing script's source, served at
 * SCRIPT_PATH, or null when the host serves it as a static file.
 */
export function createActionsCore({ routes, client = null, origins = [], onError = (error) => console.error(error), context = () => ({}), maxBytes = MAX_BYTES }) {
  if (!(maxBytes > 0)) throw new TypeError('@zubra/actions: `maxBytes` is the largest post to read, in bytes (Infinity for no limit)');
  const over = Symbol('too large');
  /** The post's fields and files, or `over` when it's bigger than maxBytes (counted as it's read). */
  async function readForm(request) {
    if (Number(request.headers.get('content-length')) > maxBytes) return over;
    if (maxBytes === Infinity || !request.body) return request.formData();
    let seen = 0;
    let tooLarge = false;
    const counted = request.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen <= maxBytes) return controller.enqueue(chunk);
          tooLarge = true;
          controller.error(new RangeError('too large'));
        },
      }),
    );
    try {
      return await new Response(counted, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
    } catch (error) {
      if (tooLarge) return over;
      throw error;
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
      return client === null ? null : new Response(client, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    }
    if (!url.pathname.startsWith(MOUNT)) return null;
    if (request.method !== 'POST') return text(405, 'Method Not Allowed', { allow: 'POST' });
    if (!allowed(request)) return text(403, 'Cross-site form posts are refused');
    const fn = routes.get(url.pathname);
    if (!fn) return text(404, 'Not Found');
    const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
    let value;
    let status = 200;
    try {
      const form = await readForm(request);
      if (form === over) {
        status = 413;
        value = TOO_LARGE;
      } else {
        const more = await context({ request, ...extra });
        value = await fn(form, { ...more, request });
      }
    } catch (error) {
      onError(error, request);
      status = 500;
      value = { error: 'Something went wrong' };
    }
    if (value instanceof Response) {
      // A redirect after success: the enhanced path is told where to go rather than following it,
      // so the page navigates once, with the location's #fragment kept (fetch drops it).
      const location = value.headers.get('location');
      if (wantsJson && location && value.status >= 300 && value.status < 400) {
        const headers = new Headers({ 'zb-location': location });
        for (const cookie of value.headers.getSetCookie()) headers.append('set-cookie', cookie);
        return new Response(null, { status: 204, headers });
      }
      return value;
    }
    if (wantsJson) {
      return new Response(JSON.stringify(value ?? null), {
        status,
        headers: { 'content-type': 'application/json', ...(status === 413 && { connection: 'close' }) },
      });
    }
    const headers = new Headers({ location: back(request) });
    // A post over the limit wasn't read to its end: don't reuse the connection.
    if (status === 413) headers.set('connection', 'close');
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

  return {
    fetch,
    result,
    routes: () => [...routes.keys()],
    script: () => `<script type="module" src="${SCRIPT_PATH}"></script>`,
    clearCookie: CLEAR,
  };
}

/** `{ url: fn }` (one component's `actions`, or several merged) as routes, refusing a URL twice. */
export function routesFrom(...maps) {
  const routes = new Map();
  for (const map of maps) {
    for (const [url, fn] of Object.entries(map ?? {})) {
      if (!url.startsWith(MOUNT) || typeof fn !== 'function') throw new TypeError(`@zubra/actions: ${url} is not an action route`);
      if (routes.has(url)) throw new Error(`@zubra/actions: two components define ${url}`);
      routes.set(url, fn);
    }
  }
  return routes;
}

function text(status, body, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}
