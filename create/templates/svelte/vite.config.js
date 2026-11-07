import { svelte } from '@sveltejs/vite-plugin-svelte';
import mnx from '@mnx/unplugin/vite';

export default { plugins: [mnx(), svelte()] };
