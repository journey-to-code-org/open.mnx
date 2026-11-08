import react from '@vitejs/plugin-react';
import zubra from '@zubra/unplugin/vite';

const ui = new URL('../ui/dist', import.meta.url).pathname;

// In .jsx files, a .zb import is a React component (props in, `on<Event>` handlers out).
export default {
  plugins: [zubra(), react()],
  // @zubra/runtime is linked from this repository, which has its own React for its tests: use the
  // app's. (Installed from npm, there's only one.)
  // @zubra-examples/ui is the library in ../ui (`npm run build` there). From npm, it would be a
  // dependency and need no alias.
  resolve: { alias: { '@zubra-examples/ui': ui }, dedupe: ['react', 'react-dom'] },
};
