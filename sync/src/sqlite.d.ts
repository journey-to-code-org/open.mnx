import type { Log } from './server.js';

/**
 * A sync log in SQLite (`node:sqlite` on Node 22.5+, `bun:sqlite` on Bun). `:memory:` by default.
 * `keep: 'latest'` keeps each field's latest value only: a newer clock replaces it and takes the
 * next cursor, an older one is dropped. Switching an existing file over carries each field's
 * latest value across. By default every change is kept.
 */
export function sqliteLog(path?: string, options?: { keep?: 'all' | 'latest' }): Promise<Log & { close(): void }>;
