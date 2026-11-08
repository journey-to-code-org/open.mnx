import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import zubra from '@zubra/unplugin/vite';

// shadcn/ui is Tailwind 4 plus Radix; the .zb components are React components in .jsx files.
export default {
  plugins: [zubra(), react(), tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname }, dedupe: ['react', 'react-dom'] },
};
