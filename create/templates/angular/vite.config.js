import angular from '@analogjs/vite-plugin-angular';
import zubra from '@zubra/unplugin/vite';

// Analog's plugin compiles Angular ahead of time inside Vite; .zb imports go through zubra.
export default {
  plugins: [zubra(), angular({ tsconfig: new URL('./tsconfig.json', import.meta.url).pathname })],
};
