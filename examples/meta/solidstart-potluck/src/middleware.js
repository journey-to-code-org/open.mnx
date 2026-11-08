// The SSR bridge: Solid renders the zubra elements' host tags (the zubra plugin adds `zb-props` in
// the server build, since `prop:` values are properties); @zubra/server gives each shadow-DOM one
// its server-rendered shadow root, each light-DOM one its rendered children (`lightDom: true`;
// Solid leaves nodes it didn't render alone while hydrating, so the board is light DOM since
// 3.3), and form controls a hidden input, so the board shows and the sign-up form submits before
// JavaScript.
import { createMiddleware } from '@solidjs/start/middleware';
import { createZubra } from '@zubra/server';

const zubra = createZubra({ components: 'zubra' });

export default createMiddleware([
  async (event, next) => {
    const response = await next();
    // A web Response, or H3's response (its body, with the headers on event.res).
    const headers = new Headers(response instanceof Response ? response.headers : event.res?.headers);
    if (!headers.get('content-type')?.includes('text/html') || !response?.body) return response;
    const html = zubra.injectShadowRoots(await new Response(response.body).text(), { lightDom: true });
    headers.delete('content-length');
    return new Response(html, { status: response.status ?? event.res?.status ?? 200, headers });
  },
]);
