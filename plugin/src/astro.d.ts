import type { ZubraOptions } from './index.js';

/** The Astro integration: `.zb` components in Astro pages, server-rendered and hydrated with a client directive. */
export default function zubra(options?: ZubraOptions): {
  name: string;
  hooks: Record<string, (...args: any[]) => unknown>;
};
