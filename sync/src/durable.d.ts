import type { Change, Documents } from './server.js';
export { durableObjectLog, type DurableObjectStorageLike } from './durable-log.js';

/** `{ collection: [{ key, ...fields }] }` */
export type Snapshot = Record<string, Array<{ key: string } & Record<string, unknown>>>;

export interface SyncObjectOptions {
  /** Default `/_zb/sync`; the Worker's `syncStub` must use the same. */
  mount?: string;
  /** Keep-alive interval (ms, default 5000), which is also how long presence outlives a closed page. */
  heartbeat?: number;
  /** The server's name in its clocks (default `server`). */
  device?: string;
  /** The log's table (default `changes`). */
  table?: string;
  /** Other origins allowed to push. */
  origins?: string[];
}

/** Extend it with your Durable Object class. Methods you add are the stub's, over RPC. */
export class SyncObject<Env = unknown> {
  static options?: SyncObjectOptions;
  constructor(ctx: any, env: Env);
  protected ctx: any;
  protected env: Env;
  /** Refuse a write or hide a change; as `createSyncServer`'s. Allows everything if not defined. */
  authorize?(asked: { request: Request; collection: string; key: string; write: boolean; kind: 'change' | 'presence' | 'read' }): boolean | Promise<boolean>;
  fetch(request: Request): Promise<Response>;
  documents(): Promise<Documents>;
  write(collection: string, key: string, fields: Record<string, unknown>): Promise<Change[]>;
  snapshot(collections?: string[]): Promise<Snapshot>;
}

export function viewOf(snapshot: Snapshot): Documents;

export function syncStub<Stub = any>(
  namespace: { idFromName(name: string): unknown; get(id: unknown): Stub },
  options?: { name?: string; mount?: string },
): {
  /** The object's stub: your SyncObject's own methods, over RPC. */
  stub: Stub;
  /** The object's answer to a sync request, or null when it isn't one. */
  fetch(request: Request): Promise<Response | null>;
  /** A copy of the documents (the collections named, or all), for rendering. Not kept current. */
  documents(...collections: string[]): Promise<Documents>;
  write(collection: string, key: string, fields: Record<string, unknown>): Promise<Change[]>;
};
