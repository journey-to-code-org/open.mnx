// `npm start` (Node.js) or `npm run start:bun` (Bun): http://localhost:3000
import { createApp } from './src/app.js';
import { createStore } from './src/store.js';

const app = createApp({ store: createStore(), cache: !process.env.DEV });
const port = Number(process.env.PORT ?? 3000);

let address;
if (globalThis.Bun) {
  address = Bun.serve({ port, fetch: app.fetch }).port;
} else {
  const { serve } = await import('@hono/node-server');
  const server = serve({ fetch: app.fetch, port });
  await new Promise((resolve) => server.once('listening', resolve));
  address = server.address().port;
}
console.log(`Spoke & Chain on http://localhost:${address} (${globalThis.Bun ? `Bun ${Bun.version}` : `Node.js ${process.versions.node}`})`);
