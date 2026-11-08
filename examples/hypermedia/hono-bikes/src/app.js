// The bike shop: Hono routes and htmx. Every route answers a plain request with a whole page
// (so it works without JavaScript) and an htmx request (`HX-Request`) with just the fragment to
// swap. Either way the zubra components in it are rendered on the server, and the browser
// hydrates them where they land, swapped in or not.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { zubra as zubraMiddleware } from '@zubra/server/hono';
import { CATEGORIES } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HTMX = readFileSync(join(dirname(require.resolve('htmx.org/package.json')), 'dist/htmx.min.js'), 'utf8');
const CSS = readFileSync(join(here, '../public/app.css'), 'utf8');
const SIZE = 10;
// htmx swaps 2xx responses; this also swaps 422, the edit row with its errors.
const HTMX_CONFIG = JSON.stringify({ responseHandling: [{ code: '204', swap: false }, { code: '[23]..', swap: true }, { code: '422', swap: true }, { code: '[45]..', swap: false, error: true }] });

export function createApp({ store, cache = true }) {
  const app = new Hono();
  // @zubra/server: renders components, and serves their modules and @zubra/runtime under /_zubra.
  const middleware = zubraMiddleware({ components: join(here, '../components'), cache });
  const zubra = middleware.zubra;
  app.use(middleware);
  const c = (name, props) => raw(zubra.render(name, props));
  app.get('/vendor/htmx.js', (ctx) => ctx.body(HTMX, 200, { 'content-type': 'text/javascript' }));
  app.get('/app.css', (ctx) => ctx.body(CSS, 200, { 'content-type': 'text/css' }));

  const htmx = (ctx) => ctx.req.header('HX-Request') === 'true';
  const lowCount = (oob = false) => html`<span id="low-count" class="low" ${oob ? raw('hx-swap-oob="true"') : ''}>${store.low()} low or out</span>`;
  const query = (params) => new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null)).toString();

  const row = (item) => html`
    <tr id="item-${item.id}">
      <td><strong>${item.name}</strong>${c('tag-list', { tags: item.tags })}</td>
      <td class="category">${item.category}</td>
      <td>${c('price-tag', { cents: item.cents })}</td>
      <td>${c('stock-gauge', { count: item.count, reorder: item.reorder })}</td>
      <td class="actions">
        <form method="post" action="/items/${item.id}/sell" hx-post="/items/${item.id}/sell" hx-target="closest tr" hx-swap="outerHTML">
          <button ${item.count === 0 ? raw('disabled') : ''}>Sell one</button>
        </form>
        <a href="/items/${item.id}/edit" hx-get="/items/${item.id}/edit" hx-target="closest tr" hx-swap="outerHTML">Edit</a>
      </td>
    </tr>`;

  const editor = (item, values = item, errors = {}) => html`
    <tr id="item-${item.id}" class="editing">
      <td colspan="5">
        <form method="post" action="/items/${item.id}" hx-post="/items/${item.id}" hx-target="closest tr" hx-swap="outerHTML" class="edit">
          <label>Name <input name="name" value="${values.name}" required></label>
          <label>Price ($) <input name="price" type="number" min="0" step="0.01" value="${(values.cents / 100).toFixed(2)}" required></label>
          <label>In stock ${c('qty-input', { name: 'count', value: values.count, min: 0, max: 999, label: `${item.name} in stock` })}</label>
          <label>Tags <input name="tags" value="${values.tags.join(', ')}" placeholder="comma, separated"></label>
          <button>Save</button>
          <a href="/" hx-get="/items/${item.id}" hx-target="closest tr" hx-swap="outerHTML">Cancel</a>
          ${Object.values(errors).map((error) => html`<p class="error">${error}</p>`)}
        </form>
      </td>
    </tr>`;

  const rows = ({ q, category, page, through = page }) => {
    // A plain request for page N shows pages 1 to N; htmx asks for one page at a time.
    const from = through === page ? 1 : page;
    const parts = [];
    let more = false;
    for (let number = from; number <= page; number++) {
      const result = store.list({ q, category, page: number, size: SIZE });
      parts.push(...result.items.map(row));
      more = result.more;
      if (!result.items.length && number === 1) parts.push(html`<tr><td colspan="5" class="empty">Nothing matches.</td></tr>`);
    }
    if (more) {
      const next = query({ q, category, page: page + 1 });
      parts.push(html`<tr id="more"><td colspan="5"><a href="/?${next}" hx-get="/items?${next}" hx-target="closest tr" hx-swap="outerHTML">Load more</a></td></tr>`);
    }
    return parts;
  };

  const layout = (title, body) => html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="htmx-config" content="${HTMX_CONFIG}">
  <title>${title} · Spoke & Chain</title>
  <link rel="stylesheet" href="/app.css">
  ${raw(zubra.head()) /* every component's CSS and the import map: htmx fragments can bring any of them */}
  <script src="/vendor/htmx.js" defer></script>
</head>
<body>
  <header class="top"><a class="brand" href="/">Spoke & Chain</a> ${lowCount()}</header>
  <main>${body}</main>
  ${raw(zubra.scripts())}
</body>
</html>`;

  const filters = (q, category) => html`
    <form action="/" method="get" class="filters" hx-get="/items" hx-target="#rows" hx-trigger="input changed delay:200ms from:find input, change from:find select, submit">
      <input type="search" name="q" value="${q}" placeholder="Search name or tag" aria-label="Search">
      <select name="category" aria-label="Category">
        <option value="">All</option>
        ${CATEGORIES.map((name) => html`<option ${name === category ? raw('selected') : ''}>${name}</option>`)}
      </select>
      <button>Filter</button>
    </form>`;

  const table = (body) => html`
    <table>
      <thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Stock</th><th></th></tr></thead>
      <tbody id="rows">${body}</tbody>
    </table>`;

  const params = (ctx) => ({ q: ctx.req.query('q') ?? '', category: ctx.req.query('category') ?? '', page: Math.max(1, Number(ctx.req.query('page')) || 1) });

  app.get('/', (ctx) => {
    const { q, category, page } = params(ctx);
    return ctx.html(layout('Inventory', html`<h1>Inventory</h1>${filters(q, category)}${table(rows({ q, category, page, through: page }))}`));
  });

  app.get('/items', (ctx) => {
    const { q, category, page } = params(ctx);
    if (!htmx(ctx)) return ctx.redirect(`/?${query({ q, category, page })}`, 303);
    return ctx.html(html`${rows({ q, category, page, through: 0 })}`);
  });

  const item = (ctx) => store.get(Number(ctx.req.param('id')));

  app.get('/items/:id', (ctx) => {
    const found = item(ctx);
    if (!found) return ctx.notFound();
    return htmx(ctx) ? ctx.html(row(found)) : ctx.redirect(`/#item-${found.id}`, 303);
  });

  app.get('/items/:id/edit', (ctx) => {
    const found = item(ctx);
    if (!found) return ctx.notFound();
    if (htmx(ctx)) return ctx.html(editor(found));
    return ctx.html(layout(`Edit ${found.name}`, html`<h1>Edit</h1>${table(editor(found))}`));
  });

  app.post('/items/:id', async (ctx) => {
    const found = item(ctx);
    if (!found) return ctx.notFound();
    const form = await ctx.req.parseBody();
    const values = {
      name: String(form.name ?? '').trim(),
      cents: Math.round(Number(form.price) * 100),
      count: Number(form.count),
      tags: String(form.tags ?? '').split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean),
    };
    const errors = {};
    if (!values.name) errors.name = 'A name, please.';
    if (!Number.isFinite(values.cents) || values.cents < 0) errors.price = 'A price of $0 or more.';
    if (!Number.isInteger(values.count) || values.count < 0 || values.count > 999) errors.count = 'A whole number of items, 0 to 999.';
    if (Object.keys(errors).length) {
      const safe = { ...values, cents: Number.isFinite(values.cents) ? values.cents : found.cents, count: Number.isInteger(values.count) ? values.count : found.count };
      if (htmx(ctx)) return ctx.html(editor(found, safe, errors), 422);
      return ctx.html(layout(`Edit ${found.name}`, html`<h1>Edit</h1>${table(editor(found, safe, errors))}`), 422);
    }
    const updated = store.update(found.id, values);
    return htmx(ctx) ? ctx.html(html`${row(updated)}${lowCount(true)}`) : ctx.redirect(`/#item-${found.id}`, 303);
  });

  app.post('/items/:id/sell', (ctx) => {
    const found = item(ctx);
    if (!found) return ctx.notFound();
    const sold = store.sell(found.id);
    return htmx(ctx) ? ctx.html(html`${row(sold)}${lowCount(true)}`) : ctx.redirect(`/#item-${found.id}`, 303);
  });

  app.post('/reset', (ctx) => {
    store.reset();
    return ctx.body(null, 204);
  });
  return app;
}
