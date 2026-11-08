import { svelte } from '@sveltejs/vite-plugin-svelte';
import zubra from '@zubra/unplugin/vite';

export default { plugins: [zubra(), svelte()] };
