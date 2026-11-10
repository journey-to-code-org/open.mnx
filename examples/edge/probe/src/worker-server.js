// @zubra/server/edge in a Worker: the components are text imports, the compiler is its wasm module.
// No components folder, no Node: createZubra over the sources.
import wasm from '@zubra/compiler/zubra.wasm';
import { createZubra } from '@zubra/server/edge';
import priceTag from '../components/price-tag.zb';

const zubra = createZubra({ wasm, components: { 'price-tag': priceTag } });

export default {
  async fetch(request) {
    // The components' browser modules (/_zubra/components/price-tag.js).
    const served = await zubra.fetch(request);
    if (served) return served;
    const page = zubra.page();
    const body = `<h1>Price</h1>${page.render('price-tag', { cents: 129900 })}`;
    return new Response(page.finish(`<!doctype html><html><head></head><body>${body}</body></html>`), { headers: { 'content-type': 'text/html' } });
  },
};
