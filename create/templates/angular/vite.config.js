import angular from '@analogjs/vite-plugin-angular';
import mnx from '@mnx/unplugin/vite';

// Analog's plugin compiles Angular ahead of time inside Vite; .mnx imports go through mnx.
export default {
  plugins: [mnx(), angular({ tsconfig: new URL('./tsconfig.json', import.meta.url).pathname })],
};
