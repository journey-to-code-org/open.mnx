/**
 * Write each component's server functions to `<out>/<component>.server.js` and `<out>/index.js`
 * exporting `actions`, for `@zubra/actions/edge`. Resolves to every route.
 */
export function buildActions(options: { components?: string; out: string }): Promise<string[]>;
