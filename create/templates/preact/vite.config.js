import preact from '@preact/preset-vite';
import mnx from '@mnx/unplugin/vite';

export default { plugins: [mnx(), preact()] };
