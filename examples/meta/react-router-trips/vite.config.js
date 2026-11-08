import { reactRouter } from '@react-router/dev/vite';
import zubra from '@zubra/unplugin/vite';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// Inside this repository, the CLI from `cargo build` stands in for @zubra/compiler's WebAssembly build.
const cli = ['debug', 'release'].map((profile) => new URL(`../../../target/${profile}/zubra${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url).pathname).find(existsSync);
if (cli) process.env.ZUBRA_COMPILER ??= cli;

// zubra recognises React Router as a React project (since 2.7): importing an .zb file gives a
// React component.
export default defineConfig({ plugins: [zubra(), reactRouter()] });
