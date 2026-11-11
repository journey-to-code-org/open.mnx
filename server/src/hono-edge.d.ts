import type { EdgeOptions, EdgeZubra } from './edge.js';
/** Hono middleware over `createZubra` from `@zubra/server/edge`: serves the modules, sets a page as `c.get('zubra')`. */
export declare function zubra(options: EdgeOptions): any & { zubra: EdgeZubra };
