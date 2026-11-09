// Express middleware: answers the action endpoints and the client script, and sets the result of
// a no-JavaScript post as `res.locals.zubraAction` (null otherwise). Mount it before any body
// parser (express.urlencoded, multer): the action reads the body itself.
//
//   import { actions } from '@zubra/actions/express';
//   app.use(await actions({ components: 'components' }));
import { createActions } from './index.js';

export async function actions(options) {
  const instance = await createActions(options);
  const middleware = (req, res, next) => {
    instance
      .handle(req, res)
      .then((answered) => {
        if (answered) return;
        res.locals.zubraAction = instance.result(req, (name, value) => res.append(name, value));
        next();
      })
      .catch(next);
  };
  middleware.actions = instance;
  return middleware;
}
