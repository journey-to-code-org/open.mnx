// The SSR bridge: Svelte renders the mnx elements' host tags; @mnx/server gives each one its
// server-rendered shadow root (and form controls a hidden input), so the page is complete, and
// its form submits, before any JavaScript.
import { createMnx } from '@mnx/server';

const mnx = createMnx({ components: 'mnx' });

export const handle = ({ event, resolve }) => resolve(event, {
  transformPageChunk: ({ html }) => mnx.injectShadowRoots(html),
});
