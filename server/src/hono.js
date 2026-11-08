// Hono middleware (Node.js, Bun, Deno, workers with a filesystem): serves the components'
// modules and the runtime, and sets a page as `c.get('zubra')`.
//
//   import { zubra } from '@zubra/server/hono';
//   app.use(zubra({ components: 'components' }));
//   app.get('/', (c) => c.html(c.get('zubra').finish(layout(c.get('zubra').render('price-tag', { cents })))));
import { createZubra } from './index.js';

export function zubra(options) {
  const instance = createZubra(options);
  const middleware = async (c, next) => {
    const response = await instance.fetch(c.req.raw);
    if (response) return response;
    c.set('zubra', instance.page());
    await next();
  };
  middleware.zubra = instance;
  return middleware;
}
