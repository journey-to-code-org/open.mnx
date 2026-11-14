// The order desk as a server-rendered page: the orders and the form are in the HTML, and the
// form posts to the server, so it works before (or without) JavaScript. The components then
// start in the browser where they are. `node hosts/server/server.mjs lit 8080` runs one.
//
// Each tool renders the page its own way (impl/<tool>/server.mjs): `page(state)` returns the
// document, and `handle(request, response)` serves the browser's script.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { orderFrom, seed } from '../../shared/data.js';

const styles = readFileSync(new URL('../../shared/styles.css', import.meta.url), 'utf8');
const escape = (text) => String(text).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);

/** The document around a tool's markup: the same head, summary, form and status for all. */
export function shell({ orders, message = '' }, { head = '', table, controls, scripts = '' }) {
  const shipped = orders.filter((order) => order.status === 'shipped').length;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Order desk (server)</title><style>${styles}</style>${head}</head>
<body>
<main>
<h1>Order desk</h1>
<p data-testid="summary">${orders.length} orders, ${shipped} shipped</p>
${table}
<h2>New order</h2>
<form method="post" action="/orders" novalidate>
${controls}
<button type="submit">Add order</button>
</form>
<p role="status">${escape(message)}</p>
</main>
${scripts}
</body>
</html>`;
}

export async function start(impl, port = 0) {
  const renderer = await (await import(`../../impl/${impl}/server.mjs`)).create();
  const orders = seed();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (await renderer.handle(request, response)) return;
      if (request.method === 'POST' && url.pathname === '/orders') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const next = orderFrom(new URLSearchParams(body), orders);
        if (!next.customer || !(next.quantity >= 1 && next.quantity <= 10)) {
          response.writeHead(422, { 'content-type': 'text/html; charset=utf-8' });
          return response.end(await renderer.page({ orders, error: 'Customer is required' }));
        }
        orders.push(next);
        return response.writeHead(303, { location: `/?added=${next.id}` }).end();
      }
      if (url.pathname !== '/') return response.writeHead(404).end();
      const added = orders.find((order) => String(order.id) === url.searchParams.get('added'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await renderer.page({ orders, error: '', message: added ? `Added order ${added.id} for ${added.customer}` : '' }));
    } catch (error) {
      console.error(error);
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, renderer, close: () => (server.closeAllConnections(), server.close()) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await start(process.argv[2] || 'zubra', Number(process.argv[3] || 8080));
  console.log(url);
}
