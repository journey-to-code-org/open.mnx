// Hono middleware for Cloudflare Workers (and Deno): the components come as sources, not a folder.
//
//   import wasm from '@zubra/compiler/zubra.wasm';
//   import { zubra } from '@zubra/server/hono-edge';
//   app.use(zubra({ wasm, components: { 'price-tag': priceTagSource } }));
//   app.get('/', (c) => c.html(c.get('zubra').finish(layout(c.get('zubra').render('price-tag', { cents })))));
import { createZubra } from './edge.js';
import { honoMiddleware } from './hono-middleware.js';

export function zubra(options) {
  return honoMiddleware(createZubra(options));
}
