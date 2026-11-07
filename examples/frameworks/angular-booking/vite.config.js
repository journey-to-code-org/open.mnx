import angular from '@analogjs/vite-plugin-angular';
import mnx from '@mnx/unplugin/vite';

// Analog's plugin compiles Angular ahead of time inside Vite, so `.mnx` imports go through
// @mnx/unplugin as in any Vite app.
export default {
  plugins: [mnx(), angular({ tsconfig: new URL('./tsconfig.json', import.meta.url).pathname })],
  // @mnx/runtime is linked from this repository, which has its own copy of Angular for its
  // tests: use the app's. (Installed from npm, there's only one.)
  resolve: { dedupe: ['@angular/core', '@angular/forms', '@angular/common'] },
};
