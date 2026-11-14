// The server page with Stencil's hydrate script (hydrate/, from `stencil build`): it renders
// the elements in the markup it is given into declarative shadow roots. Arrays go in
// attributes as JSON.
import { fileURLToPath } from 'node:url';
import { renderToString } from './hydrate/index.mjs';
import { COLUMNS } from '../../shared/data.js';
import { shell } from '../../hosts/server/server.mjs';
import { bundle } from '../../hosts/server/bundle.mjs';

const attribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export async function create() {
  const handle = await bundle(fileURLToPath(new URL('./elements.js', import.meta.url)));
  return {
    handle,
    async page(state) {
      const document = shell(state, {
        table: `<ds-table caption="Orders" columns="${attribute(JSON.stringify(COLUMNS))}" rows="${attribute(JSON.stringify(state.orders))}"></ds-table>`,
        controls: `<ds-field label="Customer" name="customer" required error="${attribute(state.error)}"></ds-field>
<ds-quantity label="Quantity" name="quantity" min="1" max="10"></ds-quantity>`,
        scripts: '<script type="module" src="/ds.js"></script>',
      });
      const result = await renderToString(document, { fullDocument: true, serializeShadowRoot: 'declarative-shadow-dom', prettyHtml: false, removeUnusedStyles: false });
      return result.html;
    },
  };
}
