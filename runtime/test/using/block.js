// `using` is syntax Node 22 can't parse, so effect.test.js imports this only where the engine
// has Explicit Resource Management (Node 24+, and the browsers that ship it).
import { Signal } from '../../src/signal.js';
import { effect, scope, tick } from '../../src/effect.js';
import { resource } from '../../src/resource.js';

/** Leave a block holding an effect, a scope and a resource; report what happened. */
export async function leaveBlock() {
  const s = new Signal.State(0);
  const log = [];
  let request;
  {
    using stop = effect(() => { log.push(`run ${s.get()}`); return () => log.push('effect cleanup'); });
    using owner = scope(() => effect(() => () => log.push('scope cleanup')));
    using data = resource(({ signal }) => { request = signal; return new Promise(() => {}); });
    void stop, owner, data;
  }
  s.set(1);
  await tick();
  return { log, aborted: request.aborted };
}
