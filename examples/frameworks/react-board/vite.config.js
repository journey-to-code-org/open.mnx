import react from '@vitejs/plugin-react';
import mnx from '@mnx/unplugin/vite';

// In .jsx files, a .mnx import is a React component (props in, `on<Event>` handlers out).
export default {
  plugins: [mnx(), react()],
  // @mnx/runtime is linked from this repository, which has its own React for its tests: use the
  // app's. (Installed from npm, there's only one.)
  resolve: { dedupe: ['react', 'react-dom'] },
};
