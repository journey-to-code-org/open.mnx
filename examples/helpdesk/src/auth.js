// Sessions in a signed cookie (HMAC-SHA256): `sid=<user id>.<signature>`. Enough for a demo
// sign-in where you pick who you are; the server re-reads the user on every request.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sessions(secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex')) {
  const sign = (value) => createHmac('sha256', secret).update(value).digest('base64url');
  const read = (cookieHeader = '') => {
    const raw = cookieHeader.split(/;\s*/).find((part) => part.startsWith('sid='))?.slice(4);
    if (!raw) return null;
    const at = raw.lastIndexOf('.');
    const value = decodeURIComponent(raw.slice(0, at));
    const given = Buffer.from(raw.slice(at + 1));
    const expected = Buffer.from(sign(value));
    return given.length === expected.length && timingSafeEqual(given, expected) ? value : null;
  };
  return {
    /** Loads `req.user` from the cookie. */
    middleware: (store) => async (req, res, next) => {
      const id = read(req.headers.cookie);
      req.user = id ? await store.getUser(id) : null;
      res.locals.user = req.user;
      next();
    },
    signIn(res, id) {
      res.cookie('sid', `${encodeURIComponent(id)}.${sign(id)}`, { httpOnly: true, sameSite: 'lax', path: '/' });
    },
    signOut(res) {
      res.clearCookie('sid', { path: '/' });
    },
  };
}
