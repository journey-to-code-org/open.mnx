// The naive Worker: use @zubra/compiler as a Node program would.
import { render } from '@zubra/compiler';

const PRICE_TAG = `<script>
  const fixed = (cents / 100).toFixed(2)
</script>
<price-tag cents={0}><data>$\${fixed}</data></price-tag>`;

export default {
  async fetch() {
    const { html } = render('/app/price-tag.zb', { props: { cents: 129900 }, files: { '/app/price-tag.zb': PRICE_TAG } });
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  },
};
