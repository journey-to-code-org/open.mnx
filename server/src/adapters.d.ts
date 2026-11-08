import type { Zubra, ZubraOptions } from './index.js';
/** Express/Connect middleware, Fastify plugin or Hono middleware (by entry point). */
export declare function zubra(options?: ZubraOptions): any & { zubra: Zubra };
