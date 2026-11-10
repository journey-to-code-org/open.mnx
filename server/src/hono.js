// Hono middleware (Node.js, Bun, Deno, workers with a filesystem): serves the components'
// modules and the runtime, and sets a page as `c.get('zubra')`. On Cloudflare Workers, which have
// no components folder, use `@zubra/server/hono-edge`.
//
//   import { zubra } from '@zubra/server/hono';
//   app.use(zubra({ components: 'components' }));
//   app.get('/', (c) => c.html(c.get('zubra').finish(layout(c.get('zubra').render('price-tag', { cents })))));
import { createZubra } from './index.js';
import { honoMiddleware } from './hono-middleware.js';

export function zubra(options) {
  return honoMiddleware(createZubra(options));
}
