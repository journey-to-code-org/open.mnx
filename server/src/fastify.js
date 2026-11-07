// A Fastify plugin: serves the components' modules and the runtime, and decorates each request
// with a page (`request.mnx`).
//
//   import { mnx } from '@mnx/server/fastify';
//   await app.register(mnx, { components: 'components' });
//   app.get('/', (request, reply) => reply.type('text/html').send(request.mnx.finish(page(request.mnx))));
import { createMnx } from './index.js';

export async function mnx(fastify, options) {
  const instance = createMnx(options);
  fastify.decorate('mnx', instance);
  fastify.decorateRequest('mnx', null);
  fastify.addHook('onRequest', (request, reply, done) => {
    if (instance.handle(request.raw, reply.raw)) {
      reply.hijack();
      return;
    }
    request.mnx = instance.page();
    done();
  });
}
// (Registered without encapsulation, so the hook and decorations apply to the whole app.)
mnx[Symbol.for('skip-override')] = true;
