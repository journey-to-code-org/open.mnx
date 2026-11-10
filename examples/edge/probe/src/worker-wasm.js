// The compiler's WebAssembly module, imported so the runtime ships it precompiled (Workers don't
// compile WebAssembly from bytes), with the request glue written out here. This is what a
// host-free @zubra/compiler entry would do.
import wasm from '../node_modules/@zubra/compiler/zubra.wasm';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let exports = null;

function request(body) {
  exports ??= new WebAssembly.Instance(wasm, {}).exports;
  const { memory, zubra_alloc, zubra_request, zubra_free } = exports;
  const bytes = encoder.encode(JSON.stringify(body));
  const pointer = zubra_alloc(bytes.length);
  new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
  const packed = BigInt.asUintN(64, zubra_request(pointer, bytes.length));
  const at = Number(packed >> 32n);
  const length = Number(packed & 0xffffffffn);
  const text = decoder.decode(new Uint8Array(memory.buffer, at, length).slice());
  zubra_free(at, length);
  return JSON.parse(text);
}

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
    let response;
    for (let i = 0; i < times; i++) response = request({ emit: 'html', path, files: { [path]: PRICE_TAG }, props: { cents: 129900 + i }, slots: {}, slotSource: 'html', partial: true });
    const ms = performance.now() - started;
    return new Response(response.ok ? response.output : `error: ${response.error}`, { headers: { 'content-type': 'text/plain', 'x-renders': String(times), 'x-ms-per-render': (ms / times).toFixed(3) } });
  },
};
