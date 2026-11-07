import { defineConfig } from 'astro/config';
import mnx from '@mnx/unplugin/astro';

// Components render to HTML on the server; client:load makes one interactive in the browser.
export default defineConfig({ integrations: [mnx()] });
