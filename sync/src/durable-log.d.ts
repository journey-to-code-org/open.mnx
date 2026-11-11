import type { Log } from './server.js';

/** The parts of a Durable Object's `ctx.storage` the log uses. */
export interface DurableObjectStorageLike {
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): any[]; one(): any } };
  transactionSync<T>(fn: () => T): T;
}

/**
 * A sync log in a Durable Object's SQLite: the table and cursors `sqliteLog` uses. `table` names
 * the table (default `changes`), if the object keeps tables of its own.
 */
export function durableObjectLog(storage: DurableObjectStorageLike, options?: { table?: string }): Log;
