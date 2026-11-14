// The Vite config for one host built with one implementation of the design system. The host's
// source imports `ds`; this points it at impl/<tool>/<binding>, and adds the build plugin a
// tool needs, if it needs one. `IMPL=lit npx vite hosts/react` runs one by hand.
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const IMPLS = ['zubra', 'lit', 'stencil', 'enhance'];
export const HOSTS = ['react', 'vue', 'svelte', 'angular'];

// React and Vue get each tool's components for that framework; Svelte and Angular use the elements.
const BINDING = { react: 'react', vue: 'vue', svelte: 'elements', angular: 'elements' };

export async function config(host, impl = process.env.IMPL || 'zubra') {
  const plugins = [];
  // The one tool here with a build plugin: .zb files are compiled as they're imported.
  if (impl === 'zubra') plugins.push((await import('@zubra/unplugin/vite')).default({ root: `${root}impl/zubra` }));
  if (host === 'react') plugins.push((await import('@vitejs/plugin-react')).default());
  if (host === 'vue') plugins.push((await import('@vitejs/plugin-vue')).default());
  if (host === 'svelte') plugins.push((await import('@sveltejs/vite-plugin-svelte')).svelte());
  if (host === 'angular') plugins.push((await import('@analogjs/vite-plugin-angular')).default({ tsconfig: `${root}hosts/angular/tsconfig.json` }));
  return {
    root: `${root}hosts/${host}`,
    base: './',
    plugins,
    resolve: {
      alias: [
        { find: /^ds$/, replacement: `${root}impl/${impl}/${BINDING[host]}` },
        // Stencil's generated React and Vue components import its elements by package name.
        { find: /^coexist-stencil/, replacement: `${root}impl/stencil` },
      ],
    },
  };
}
