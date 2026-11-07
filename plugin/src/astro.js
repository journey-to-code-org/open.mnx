// Astro integration: `.mnx` components in Astro pages, server-rendered, hydrated with a client
// directive.
//
//   // astro.config.mjs
//   import mnx from '@mnx/unplugin/astro'
//   export default { integrations: [mnx()] }
//
//   ---
//   import Rating from '../components/rating.mnx'
//   ---
//   <Rating value={3} client:load />      <!-- server-rendered, then hydrated in the browser -->
//   <Rating value={3} />                  <!-- server-rendered HTML only -->
//
// Props go to the component; other attributes (`class`, `id`, `data-*`) to its host element.
// Children are slot content (`slot="name"` for a named slot). Options are the plugin's.
import vite from './vite.js';

export default function mnx(options = {}) {
  return {
    name: '@mnx/astro',
    hooks: {
      'astro:config:setup': ({ addRenderer, updateConfig }) => {
        addRenderer({
          name: '@mnx/astro',
          serverEntrypoint: '@mnx/unplugin/astro/server',
          clientEntrypoint: '@mnx/unplugin/astro/client',
        });
        updateConfig({ vite: { plugins: [vite({ framework: 'element', ...options })] } });
      },
    },
  };
}
