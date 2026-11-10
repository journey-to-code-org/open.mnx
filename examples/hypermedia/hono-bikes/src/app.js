// The bike shop on Node.js or Bun: the routes are shop.js's; this reads what a server with a disk
// has (the components folder, htmx, the stylesheet) and hands it over.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zubra as zubraMiddleware } from '@zubra/server/hono';
import { createShop } from './shop.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HTMX = readFileSync(join(dirname(require.resolve('htmx.org/package.json')), 'dist/htmx.min.js'), 'utf8');
const CSS = readFileSync(join(here, '../public/app.css'), 'utf8');

export function createApp({ store, cache = true }) {
  // @zubra/server: renders components, and serves their modules and @zubra/runtime under /_zubra.
  const middleware = zubraMiddleware({ components: join(here, '../components'), cache });
  return createShop({ store, middleware, htmx: HTMX, css: CSS });
}
