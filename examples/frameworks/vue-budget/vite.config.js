import vue from '@vitejs/plugin-vue';
import mnx from '@mnx/unplugin/vite';

// In .vue files, a .mnx import is a Vue component: props, @events, v-model and slots.
export default {
  plugins: [mnx(), vue()],
  // @mnx/runtime is linked from this repository, which has its own Vue for its tests: use the
  // app's. (Installed from npm, there's only one.)
  resolve: { dedupe: ['vue'] },
};
