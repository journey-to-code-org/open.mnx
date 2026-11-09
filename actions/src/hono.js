// Hono middleware: answers the action endpoints and the client script, and sets the result of a
// no-JavaScript post as `c.get('zubraAction')` (null otherwise) for the page to render.
//
//   import { actions } from '@zubra/actions/hono';
//   app.use(await actions({ components: 'components' }));
import { createActions } from './index.js';

export async function actions(options) {
  const instance = await createActions(options);
  const middleware = async (c, next) => {
    const response = await instance.fetch(c.req.raw, { c });
    if (response) return response;
    c.set('zubraAction', instance.result(c.req.raw, (name, value) => c.header(name, value, { append: true })));
    await next();
  };
  middleware.actions = instance;
  return middleware;
}
