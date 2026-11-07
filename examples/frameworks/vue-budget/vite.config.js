import vue from '@vitejs/plugin-vue';
import mnx from '@mnx/unplugin/vite';

const ui = new URL('../ui/dist', import.meta.url).pathname;

// In .vue files, a .mnx import is a Vue component: props, @events, v-model and slots.
export default {
  plugins: [mnx(), vue()],
  // @mnx/runtime is linked from this repository, which has its own Vue for its tests: use the
  // app's. (Installed from npm, there's only one.)
  // @mnx-examples/ui is the library in ../ui (`npm run build` there). From npm, it would be a
  // dependency and need no alias.
  resolve: { alias: { '@mnx-examples/ui': ui }, dedupe: ['vue'] },
};
