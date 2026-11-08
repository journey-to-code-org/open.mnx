// Astro integration: `.zb` components in Astro pages, server-rendered, hydrated with a client
// directive.
//
//   // astro.config.mjs
//   import zubra from '@zubra/unplugin/astro'
//   export default { integrations: [zubra()] }
//
//   ---
//   import Rating from '../components/rating.zb'
//   ---
//   <Rating value={3} client:load />      <!-- server-rendered, then hydrated in the browser -->
//   <Rating value={3} />                  <!-- server-rendered HTML only -->
//
// Props go to the component; other attributes (`class`, `id`, `data-*`) to its host element.
// Children are slot content (`slot="name"` for a named slot). Options are the plugin's.
import vite from './vite.js';

export default function zubra(options = {}) {
  return {
    name: '@zubra/astro',
    hooks: {
      'astro:config:setup': ({ addRenderer, updateConfig }) => {
        addRenderer({
          name: '@zubra/astro',
          serverEntrypoint: '@zubra/unplugin/astro/server',
          clientEntrypoint: '@zubra/unplugin/astro/client',
        });
        updateConfig({
          vite: {
            plugins: [vite({ framework: 'element', ...options })],
            // The server build renders with @zubra/compiler, which loads zubra.wasm from beside
            // itself: bundled into Astro's prerender chunks, it would look for it there. (From
            // npm it's external anyway; linked or in a workspace, Vite would bundle it.)
            // Astro prerenders in its own Vite environment, so this is `resolve.external` (every
            // server environment), not `ssr.external`.
            resolve: { external: [options.compilerModule ?? '@zubra/compiler'] },
          },
        });
      },
    },
  };
}
