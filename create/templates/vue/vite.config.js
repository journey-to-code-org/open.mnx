import vue from '@vitejs/plugin-vue';
import mnx from '@mnx/unplugin/vite';

export default { plugins: [mnx(), vue()] };
