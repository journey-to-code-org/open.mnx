// Express (and Connect) middleware: serves the components' modules and the runtime, and gives
// each request a page as `res.locals.zubra`, for any template engine:
//
//   import { zubra } from '@zubra/server/express';
//   app.use(zubra({ components: 'components' }));
//   // in a view (EJS): <%- zubra.render('ticket-table', { tickets }) %>
//   // then: res.send(res.locals.zubra.finish(html)), or <%- zubra.head() %> / <%- zubra.scripts() %>
import { createZubra } from './index.js';

export function zubra(options) {
  const instance = createZubra(options);
  const middleware = (req, res, next) => {
    if (instance.handle(req, res)) return;
    res.locals ??= {};
    res.locals.zubra = instance.page();
    next();
  };
  middleware.zubra = instance;
  return middleware;
}
