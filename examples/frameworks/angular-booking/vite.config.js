import angular from '@analogjs/vite-plugin-angular';
import zubra from '@zubra/unplugin/vite';

// Analog's plugin compiles Angular ahead of time inside Vite, so `.zb` imports go through
// @zubra/unplugin as in any Vite app.
export default {
  // zubra-snippet:start angular-vite
  plugins: [zubra(), angular({ tsconfig: new URL('./tsconfig.json', import.meta.url).pathname })],
  // zubra-snippet:end angular-vite
  // @zubra/runtime is linked from this repository, which has its own copy of Angular for its
  // tests: use the app's. (Installed from npm, there's only one.)
  resolve: { dedupe: ['@angular/core', '@angular/forms', '@angular/common'] },
};
