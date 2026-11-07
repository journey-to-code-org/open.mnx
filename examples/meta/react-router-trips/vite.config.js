import { reactRouter } from '@react-router/dev/vite';
import mnx from '@mnx/unplugin/vite';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// Inside this repository, the CLI from `cargo build` stands in for @mnx/compiler's WebAssembly build.
const cli = ['debug', 'release'].map((profile) => new URL(`../../../target/${profile}/mnx${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url).pathname).find(existsSync);
if (cli) process.env.MNX_COMPILER ??= cli;

// React Router's Vite plugin isn't @vitejs/plugin-react, so tell mnx this is a React project:
// importing an .mnx file then gives a React component.
export default defineConfig({ plugins: [mnx({ framework: 'react' }), reactRouter()] });
