// The server page with @lit-labs/ssr: the elements render into declarative shadow roots, and
// the browser's script (the hydration support first, then the elements) takes them over.
// Arrays go in attributes as JSON, so the elements in the browser start with the same data.
import { fileURLToPath } from 'node:url';
import { render } from '@lit-labs/ssr';
import { collectResultSync } from '@lit-labs/ssr/lib/render-result.js';
import { html } from 'lit';
import './elements.js';
import { COLUMNS } from '../../shared/data.js';
import { shell } from '../../hosts/server/server.mjs';
import { bundle } from '../../hosts/server/bundle.mjs';

const text = (template) => collectResultSync(render(template));

export async function create() {
  const handle = await bundle(fileURLToPath(new URL('./hydrate.js', import.meta.url)));
  return {
    handle,
    page: (state) => shell(state, {
      table: text(html`<ds-table caption="Orders" columns=${JSON.stringify(COLUMNS)} rows=${JSON.stringify(state.orders)}></ds-table>`),
      controls: text(html`
        <ds-field label="Customer" name="customer" required error=${state.error}></ds-field>
        <ds-quantity label="Quantity" name="quantity" min="1" max="10"></ds-quantity>
      `),
      scripts: '<script type="module" src="/ds.js"></script>',
    }),
  };
}
