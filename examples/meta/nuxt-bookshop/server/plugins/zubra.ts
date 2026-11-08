// The SSR bridge: Vue renders the zubra elements' host tags (the Vue wrapper writes their props as
// `zb-props`); @zubra/server gives each shadow-DOM one its server-rendered shadow root, so the
// shop's stock meters and badges show before any JavaScript.
import { createZubra } from '@zubra/server';

const zubra = createZubra({ components: 'zubra' });

export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('render:html', (html) => {
    html.body = html.body.map((chunk) => zubra.injectShadowRoots(chunk));
  });
});
