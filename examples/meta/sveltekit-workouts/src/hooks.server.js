// The SSR bridge: Svelte renders the zubra elements' host tags; @zubra/server gives each one its
// server-rendered shadow root (and form controls a hidden input), so the page is complete, and
// its form submits, before any JavaScript.
import { createZubra } from '@zubra/server';

const zubra = createZubra({ components: 'zubra' });

export const handle = ({ event, resolve }) => resolve(event, {
  transformPageChunk: ({ html }) => zubra.injectShadowRoots(html),
});
