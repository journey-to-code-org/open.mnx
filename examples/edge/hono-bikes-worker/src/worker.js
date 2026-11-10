// The Spoke & Chain bike shop on a Cloudflare Worker. The routes, the store and the components are
// the Node.js example's (examples/hypermedia/hono-bikes); what's different is the host:
//   - the compiler is its WebAssembly module, imported so the runtime ships it compiled;
//   - the components are text imports, handed to @zubra/server/edge as sources;
//   - htmx, the stylesheet and @zubra/runtime are static assets (wrangler.jsonc), so the shop is
//     given none of them to serve.
import wasm from '@zubra/compiler/zubra.wasm';
import { zubra } from '@zubra/server/hono-edge';
import { createShop } from '../../../hypermedia/hono-bikes/src/shop.js';
import { createStore } from '../../../hypermedia/hono-bikes/src/store.js';
import priceTag from '../../../hypermedia/hono-bikes/components/price-tag.zb';
import qtyInput from '../../../hypermedia/hono-bikes/components/qty-input.zb';
import stockGauge from '../../../hypermedia/hono-bikes/components/stock-gauge.zb';
import tagList from '../../../hypermedia/hono-bikes/components/tag-list.zb';

const middleware = zubra({
  wasm,
  components: { 'price-tag': priceTag, 'qty-input': qtyInput, 'stock-gauge': stockGauge, 'tag-list': tagList },
});

// The inventory lives in the Worker's memory, as the Node.js example's does in its process: it lasts
// as long as the isolate does, which is fine for a demonstration and wrong for a shop.
export default createShop({ store: createStore(), middleware });
