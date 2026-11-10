// @zubra/compiler without a host: the compiler's WebAssembly module, imported (so the runtime ships
// it precompiled; Workers don't compile WebAssembly from bytes), handed to createCompiler.
import wasm from '@zubra/compiler/zubra.wasm';
import { createCompiler } from '@zubra/compiler/wasm';

const zubra = createCompiler(wasm);

const PRICE_TAG = `<script>
  const fixed = (cents / 100).toFixed(2)
</script>
<price-tag cents={0}><data>$\{fixed}</data></price-tag>`;

export default {
  async fetch(req) {
    // ?n=100 renders the component that many times in one request: the cost once the module is warm.
    const times = Math.min(Number(new URL(req.url).searchParams.get('n')) || 1, 1000);
    const path = '/app/price-tag.zb';
    const started = performance.now();
    let html;
    for (let i = 0; i < times; i++) html = zubra.renderToString(path, { files: { [path]: PRICE_TAG }, props: { cents: 129900 + i } });
    const ms = performance.now() - started;
    return new Response(html, { headers: { 'content-type': 'text/plain', 'x-renders': String(times), 'x-ms-per-render': (ms / times).toFixed(3) } });
  },
};
