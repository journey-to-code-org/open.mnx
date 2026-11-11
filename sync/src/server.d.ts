export interface Change {
  collection: string;
  key: string;
  field: string;
  value: unknown;
  /** A hybrid logical clock: `<15-digit ms>-<5-digit counter>-<client id>`. */
  clock: string;
}

export interface Log {
  append(changes: Change[]): Promise<unknown>;
  after(cursor: string, limit?: number): Promise<{ changes: Change[]; cursor: number | string }>;
}

export function memoryLog(): Log;

export interface Documents {
  /** A document's fields (a copy), or undefined when nothing has been written to it. */
  get(collection: string, key: string): Record<string, unknown> | undefined;
  /** Every document in a collection, each with its key. */
  all(collection: string): Array<{ key: string } & Record<string, unknown>>;
}

export function createSyncServer(options?: {
  log?: Log;
  /** Default `/_zb/sync`. */
  mount?: string;
  /**
   * Refuse a write, or hide a change from a reader, by returning false. `kind` is what's asked:
   * 'change' (a push), 'presence' (joining or signaling in a document's room; nothing is stored)
   * or 'read' (a change about to be sent to this request). `write` is true for the first two.
   */
  authorize?: (from: { request: Request; collection: string; key: string; write: boolean; kind: 'change' | 'presence' | 'read' }) => boolean | Promise<boolean>;
  /** Other origins allowed to push. */
  origins?: string[];
  /** How often the live stream sends a keep-alive comment (ms, default 15000). */
  heartbeat?: number;
  /** The server's name in the clocks of its own writes (default `server`). */
  device?: string;
}): {
  fetch(request: Request): Promise<Response | null>;
  /**
   * Every document as the devices merge it (last writer wins, per field), read from the log the
   * first time and kept current after. Its reads are synchronous.
   */
  documents(): Promise<Documents>;
  /**
   * Write fields to a document as the server, with a clock later than any it has seen: to the
   * documents view at once, then to the log and every live page. Resolves to the changes.
   */
  write(collection: string, key: string, fields: Record<string, unknown>): Promise<Change[]>;
  /** Node's http: answers sync requests (streaming the live ones) and resolves true, else false. */
  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean>;
};
