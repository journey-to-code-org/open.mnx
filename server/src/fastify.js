// A Fastify plugin: serves the components' modules and the runtime, and decorates each request
// with a page (`request.zubra`).
//
//   import { zubra } from '@zubra/server/fastify';
//   await app.register(zubra, { components: 'components' });
//   app.get('/', (request, reply) => reply.type('text/html').send(request.zubra.finish(page(request.zubra))));
import { createZubra } from './index.js';

export async function zubra(fastify, options) {
  const instance = createZubra(options);
  fastify.decorate('zubra', instance);
  fastify.decorateRequest('zubra', null);
  fastify.addHook('onRequest', (request, reply, done) => {
    if (instance.handle(request.raw, reply.raw)) {
      reply.hijack();
      return;
    }
    request.zubra = instance.page();
    done();
  });
}
// (Registered without encapsulation, so the hook and decorations apply to the whole app.)
zubra[Symbol.for('skip-override')] = true;
