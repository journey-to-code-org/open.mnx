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

export function createSyncServer(options?: {
  log?: Log;
  /** Default `/_zb/sync`. */
  mount?: string;
  /** Refuse a write, or hide a change from a reader, by returning false. */
  authorize?: (from: { request: Request; collection: string; key: string; write: boolean }) => boolean | Promise<boolean>;
  /** Other origins allowed to push. */
  origins?: string[];
  /** How often the live stream sends a keep-alive comment (ms, default 15000). */
  heartbeat?: number;
}): {
  fetch(request: Request): Promise<Response | null>;
  /** Node's http: answers sync requests (streaming the live ones) and resolves true, else false. */
  handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<boolean>;
};
