import react from '@vitejs/plugin-react';
import mnx from '@mnx/unplugin/vite';

export default { plugins: [mnx(), react()] };
