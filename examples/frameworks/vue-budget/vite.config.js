import vue from '@vitejs/plugin-vue';
import zubra from '@zubra/unplugin/vite';

const ui = new URL('../ui/dist', import.meta.url).pathname;

// In .vue files, a .zb import is a Vue component: props, @events, v-model and slots.
export default {
  plugins: [zubra(), vue()],
  // @zubra/runtime is linked from this repository, which has its own Vue for its tests: use the
  // app's. (Installed from npm, there's only one.)
  // @zubra-examples/ui is the library in ../ui (`npm run build` there). From npm, it would be a
  // dependency and need no alias.
  resolve: { alias: { '@zubra-examples/ui': ui }, dedupe: ['vue'] },
};
