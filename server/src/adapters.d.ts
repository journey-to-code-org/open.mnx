import type { Mnx, MnxOptions } from './index.js';
/** Express/Connect middleware, Fastify plugin or Hono middleware (by entry point). */
export declare function mnx(options?: MnxOptions): any & { mnx: Mnx };
