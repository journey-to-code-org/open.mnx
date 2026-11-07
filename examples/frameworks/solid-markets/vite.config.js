import solid from 'vite-plugin-solid';
import mnx from '@mnx/unplugin/vite';

// Solid uses the elements directly: `prop:` sets properties, `on:` listens for their events.
export default { plugins: [mnx(), solid()] };
