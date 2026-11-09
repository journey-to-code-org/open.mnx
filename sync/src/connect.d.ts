/**
 * Share 'use collection' documents through a log at `url` (default `/_zb/sync`), pulling every
 * `interval` ms (default 2000). Writes stay on the device first and go out when the network allows.
 */
export function connect(options?: {
  url?: string;
  /** How often to poll while the live stream is closed (ms, default 2000). */
  interval?: number;
  /** Open the live event stream (default true). */
  live?: boolean;
}): {
  flush(): Promise<void>;
  pull(): Promise<void>;
  stop(): void;
};
