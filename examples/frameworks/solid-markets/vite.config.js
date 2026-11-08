import solid from 'vite-plugin-solid';
import zubra from '@zubra/unplugin/vite';

// Solid uses the elements directly: `prop:` sets properties, `on:` listens for their events.
export default { plugins: [zubra(), solid()] };
