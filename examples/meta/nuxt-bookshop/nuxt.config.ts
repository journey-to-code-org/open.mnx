import mnx from '@mnx/unplugin/vite';

// The mnx plugin compiles .mnx imports; in .vue files they're Vue components (props, v-model,
// events, slots), with typings written next to each component.
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  devtools: { enabled: false },
  css: ['~/assets/main.css'],
  vite: { plugins: [mnx()] },
  app: { head: { title: 'Shelfwise', htmlAttrs: { lang: 'en' } } },
});
