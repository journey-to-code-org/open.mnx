import { svelte } from '@sveltejs/vite-plugin-svelte';
import mnx from '@mnx/unplugin/vite';

// Svelte uses the elements directly: props as properties, events with on<name>.
export default { plugins: [mnx(), svelte()] };
