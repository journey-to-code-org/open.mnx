/**
 * Share 'use collection' documents through a log at `url` (default `/_zb/sync`), pulling every
 * `interval` ms (default 2000). Writes stay on the device first and go out when the network allows.
 */
export function connect(options?: { url?: string; interval?: number }): {
  flush(): Promise<void>;
  pull(): Promise<void>;
  stop(): void;
};
