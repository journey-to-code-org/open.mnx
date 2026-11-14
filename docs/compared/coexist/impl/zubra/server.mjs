// The server page with @zubra/server: it renders each component from its .zb file, adds the
// CSS and modules of those the page used, and serves them and the runtime under /_zubra.
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { COLUMNS } from '../../shared/data.js';
import { shell } from '../../hosts/server/server.mjs';

export async function create() {
  const zubra = createZubra({ components: fileURLToPath(new URL('./components', import.meta.url)), production: true, clientModules: 'needed' });
  return {
    handle: (request, response) => zubra.handle(request, response),
    page(state) {
      const page = zubra.page();
      return page.finish(shell(state, {
        table: page.render('ds-table', { caption: 'Orders', columns: COLUMNS, rows: state.orders }),
        controls:
          page.render('ds-field', { label: 'Customer', name: 'customer', required: true, error: state.error }) +
          page.render('ds-quantity', { label: 'Quantity', name: 'quantity', min: 1, max: 10 }),
      }));
    },
  };
}
