/** `let editing = ephemeral(false)`: state a `'use collection'` component doesn't store. */
export function ephemeral<T>(value: T): T;

/** Where documents live. `set` merges `fields` into the stored document. */
export interface Store {
  get(collection: string, key: string): Promise<Record<string, unknown> | undefined>;
  set(collection: string, key: string, fields: Record<string, unknown>): Promise<void>;
}

/** Use another store, before any `'use collection'` element starts. */
export function configure(options: { store?: Store }): void;

/** The default in browsers: one IndexedDB database (`zubra-sync`), one record per document. */
export function indexedDBStore(database?: string): Store;

/** A store in memory, for tests and places without IndexedDB. */
export function memoryStore(): Store;

/** Called by compiled components; not for direct use. */
export function collection(
  name: string,
  keys: string[],
  props: Record<string, unknown>,
  fields: Record<string, { get(): unknown; set(value: unknown): void }>,
): void;
