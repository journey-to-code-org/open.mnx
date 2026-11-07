import { solidStart } from '@solidjs/start/config';
import mnx from '@mnx/unplugin/vite';
import { nitro } from 'nitro/vite';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';

// Inside this repository, the CLI from `cargo build` stands in for @mnx/compiler's WebAssembly build.
const cli = ['debug', 'release'].map((profile) => new URL(`../../../target/${profile}/mnx${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url).pathname).find(existsSync);
if (cli) process.env.MNX_COMPILER ??= cli;

export default defineConfig({ plugins: [mnx(), solidStart(), nitro()] });
