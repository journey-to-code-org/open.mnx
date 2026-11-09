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
  /**
   * Send presence over WebRTC data channels to the peers that can be reached directly; the
   * server carries introductions, goodbyes, signaling, and presence to anyone else.
   */
  webrtc?: boolean | { iceServers?: RTCIceServer[] };
}): {
  flush(): Promise<void>;
  pull(): Promise<void>;
  /** The peers presence currently goes to directly (webrtc). */
  direct(): string[];
  stop(): void;
};
