import { solidStart } from '@solidjs/start/config';
import zubra from '@zubra/unplugin/vite';
import { nitro } from 'nitro/vite';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// Inside this repository, the CLI from `cargo build` stands in for @zubra/compiler's WebAssembly build.
const cli = ['debug', 'release'].map((profile) => new URL(`../../../target/${profile}/zubra${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url).pathname).find(existsSync);
if (cli) process.env.ZUBRA_COMPILER ??= cli;

export default defineConfig({ plugins: [zubra(), solidStart({ middleware: './src/middleware.js' }), nitro()] });
