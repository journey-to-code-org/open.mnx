import preact from '@preact/preset-vite';
import mnx from '@mnx/unplugin/vite';

// Preact uses the elements directly: props are set as properties, on<name> listens for events.
export default { plugins: [mnx(), preact()] };
