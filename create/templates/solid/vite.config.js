import solid from 'vite-plugin-solid';
import mnx from '@mnx/unplugin/vite';

export default { plugins: [mnx(), solid()] };
