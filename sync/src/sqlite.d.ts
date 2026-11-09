import type { Log } from './server.js';

/** A sync log in SQLite (`node:sqlite` on Node 22.5+, `bun:sqlite` on Bun). `:memory:` by default. */
export function sqliteLog(path?: string): Promise<Log & { close(): void }>;
