import { svelte } from '@sveltejs/vite-plugin-svelte';
import zubra from '@zubra/unplugin/vite';

// Svelte uses the elements directly: props as properties, events with on<name>.
export default { plugins: [zubra(), svelte()] };
