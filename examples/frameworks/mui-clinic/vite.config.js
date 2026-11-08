import react from '@vitejs/plugin-react';
import zubra from '@zubra/unplugin/vite';

// In .jsx files, a .zb import is a React component (props in, `on<Event>` handlers out).
export default {
  plugins: [zubra(), react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  // React, MUI and Emotion are most of the bundle (about 160 KB gzipped in all); one chunk is fine for a demo.
  build: { chunkSizeWarningLimit: 700 },
};
