// Hono middleware (Node.js, Bun, Deno, workers with a filesystem): serves the components'
// modules and the runtime, and sets a page as `c.get('mnx')`.
//
//   import { mnx } from '@mnx/server/hono';
//   app.use(mnx({ components: 'components' }));
//   app.get('/', (c) => c.html(c.get('mnx').finish(layout(c.get('mnx').render('price-tag', { cents })))));
import { createMnx } from './index.js';

export function mnx(options) {
  const instance = createMnx(options);
  const middleware = async (c, next) => {
    const response = await instance.fetch(c.req.raw);
    if (response) return response;
    c.set('mnx', instance.page());
    await next();
  };
  middleware.mnx = instance;
  return middleware;
}
