// The server page with @enhance/ssr: it expands each element with its element function (the
// same ones the browser uses) and moves their styles to the head. Arrays go in attributes as
// JSON.
import { fileURLToPath } from 'node:url';
import enhance from '@enhance/ssr';
import DsBadge from './elements/ds-badge.mjs';
import DsField from './elements/ds-field.mjs';
import DsQuantity from './elements/ds-quantity.mjs';
import DsTable from './elements/ds-table.mjs';
import { esc } from './read.mjs';
import { COLUMNS } from '../../shared/data.js';
import { shell } from '../../hosts/server/server.mjs';
import { bundle } from '../../hosts/server/bundle.mjs';

export async function create() {
  const handle = await bundle(fileURLToPath(new URL('./elements.js', import.meta.url)));
  const html = enhance({ elements: { 'ds-badge': DsBadge, 'ds-field': DsField, 'ds-quantity': DsQuantity, 'ds-table': DsTable } });
  return {
    handle,
    page: (state) => html`${shell(state, {
      table: `<ds-table caption="Orders" columns="${esc(JSON.stringify(COLUMNS))}" rows="${esc(JSON.stringify(state.orders))}"></ds-table>`,
      controls: `<ds-field label="Customer" name="customer" required error="${esc(state.error)}"></ds-field>
<ds-quantity label="Quantity" name="quantity" min="1" max="10"></ds-quantity>`,
      scripts: '<script type="module" src="/ds.js"></script>',
    })}`,
  };
}
