// The Hono middleware over any Zubra instance: serves its modules (and whatever else it serves
// under its prefix), and sets a page as `c.get('zubra')`. `hono.js` makes the instance from a
// components folder; `hono-edge.js` from sources, for Workers.
export function honoMiddleware(instance) {
  const middleware = async (c, next) => {
    const response = await instance.fetch(c.req.raw);
    if (response) return response;
    c.set('zubra', instance.page());
    await next();
  };
  middleware.zubra = instance;
  return middleware;
}
