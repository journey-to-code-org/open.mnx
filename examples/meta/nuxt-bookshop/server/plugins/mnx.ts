// The SSR bridge: Vue renders the mnx elements' host tags (the Vue wrapper writes their props as
// `mnx-props`); @mnx/server gives each shadow-DOM one its server-rendered shadow root, so the
// shop's stock meters and badges show before any JavaScript.
import { createMnx } from '@mnx/server';

const mnx = createMnx({ components: 'mnx' });

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('render:html', (html) => {
    html.body = html.body.map((chunk) => mnx.injectShadowRoots(chunk));
  });
});
