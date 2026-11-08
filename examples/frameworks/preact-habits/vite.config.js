import preact from '@preact/preset-vite';
import zubra from '@zubra/unplugin/vite';

// Preact uses the elements directly: props are set as properties, on<name> listens for events.
export default { plugins: [zubra(), preact()] };
