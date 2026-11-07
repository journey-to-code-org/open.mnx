// Express (and Connect) middleware: serves the components' modules and the runtime, and gives
// each request a page as `res.locals.mnx`, for any template engine:
//
//   import { mnx } from '@mnx/server/express';
//   app.use(mnx({ components: 'components' }));
//   // in a view (EJS): <%- mnx.render('ticket-table', { tickets }) %>
//   // then: res.send(res.locals.mnx.finish(html)), or <%- mnx.head() %> / <%- mnx.scripts() %>
import { createMnx } from './index.js';

export function mnx(options) {
  const instance = createMnx(options);
  const middleware = (req, res, next) => {
    if (instance.handle(req, res)) return;
    res.locals ??= {};
    res.locals.mnx = instance.page();
    next();
  };
  middleware.mnx = instance;
  return middleware;
}
