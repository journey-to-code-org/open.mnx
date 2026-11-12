import type { ActionResult } from './index.js';

export const MOUNT: '/_zb/action/';
export const SCRIPT_PATH: '/_zb/actions.js';
export const COOKIE: '__zb_result';

/** A server function: the form's data, and `request` with whatever `context()` returned. */
export type ActionFunction = (formData: FormData, context: { request: Request; [key: string]: unknown }) => unknown;

export interface EdgeActionsOptions<Extra extends object = object> {
  /** `{ '/_zb/action/<tag>/<name>': fn }`: `actions` from `zubra-actions build`'s index.js. */
  actions: Record<string, ActionFunction>;
  /** The enhancing script's source, to serve at `/_zb/actions.js`. Default: serve it from static assets. */
  client?: string | null;
  /** Other origins allowed to post, beyond the request's own. */
  origins?: string[];
  /** Called when a server function throws. The client gets a generic error either way. */
  onError?: (error: unknown, request: Request) => void;
  /**
   * The largest post read, files and fields together, in bytes: 10 MB by default, `Infinity` for
   * no limit. A bigger one gets `{ error: 'Too large' }` (status 413) and the function doesn't run.
   */
  maxBytes?: number;
  /** What else a server function gets beside `request`; `extra` is fetch's second argument (`{ env, ctx }`). */
  context?: (from: { request: Request } & Extra) => object | Promise<object>;
}

export interface EdgeActions<Extra extends object = object> {
  /** A Response for an action (or the client script, when `client` was given); null for any other request. */
  fetch(request: Request, extra?: Extra): Promise<Response | null>;
  /** After a no-JavaScript post, its result, once; `setHeader` gets the header that clears it. */
  result<T = unknown>(request: Request, setHeader?: (name: string, value: string) => void): ActionResult<T> | null;
  routes(): string[];
  script(): string;
  clearCookie: string;
}

export function createActions<Extra extends object = object>(options: EdgeActionsOptions<Extra>): EdgeActions<Extra>;
