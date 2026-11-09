// Fastify plugin: answers the action endpoints (before Fastify parses the body) and the client
// script, and sets the result of a no-JavaScript post as `request.zubraAction` (null otherwise).
//
//   import { actions } from '@zubra/actions/fastify';
//   await app.register(actions, { components: 'components' });
import { createActions } from './index.js';

export async function actions(app, options) {
  const instance = await createActions(options);
  app.decorateRequest('zubraAction', null);
  app.addHook('onRequest', async (request, reply) => {
    if (await instance.handle(request.raw, reply.raw)) return reply.hijack();
    request.zubraAction = instance.result(request.raw, (name, value) => reply.header(name, value));
  });
}
actions[Symbol.for('skip-override')] = true;
