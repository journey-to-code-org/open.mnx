// The SSR bridge: Solid renders the mnx elements' host tags (with `mnx-props`, since `prop:`
// values are properties); @mnx/server gives each shadow-DOM one its server-rendered shadow
// root, and form controls a hidden input, so the board shows and the sign-up form submits
// before JavaScript.
import { createMiddleware } from '@solidjs/start/middleware';
import { createMnx } from '@mnx/server';

const mnx = createMnx({ components: 'mnx' });

export default createMiddleware([
  async (event, next) => {
    const response = await next();
    // A web Response, or H3's response (its body, with the headers on event.res).
    const headers = new Headers(response instanceof Response ? response.headers : event.res?.headers);
    if (!headers.get('content-type')?.includes('text/html') || !response?.body) return response;
    const html = mnx.injectShadowRoots(await new Response(response.body).text());
    headers.delete('content-length');
    return new Response(html, { status: response.status ?? event.res?.status ?? 200, headers });
  },
]);
