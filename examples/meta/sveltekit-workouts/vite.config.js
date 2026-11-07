import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import mnx from '@mnx/unplugin/vite';

// mnx first: .mnx imports become elements (Svelte uses them directly: properties in, events out).
// The built server checks form posts against its origin, set when building (ORIGIN=…, default
// http://localhost:3000, where `npm start` listens).
export default {
  plugins: [mnx(), sveltekit({ adapter: adapter(), paths: { origin: process.env.ORIGIN ?? 'http://localhost:3000' } })],
};
