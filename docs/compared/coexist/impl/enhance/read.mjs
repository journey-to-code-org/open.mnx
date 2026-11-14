// What an element function needs to be the same on the server and in the browser: a prop's
// value, from the element's property in the browser or its attribute (JSON for arrays) on the
// server, and escaping, which Enhance's `html` leaves to the author.
const convert = {
  string: (text) => text,
  number: (text) => Number(text),
  boolean: (text) => text !== 'false',
  array: (text) => JSON.parse(text),
};

export function read(state, name, fallback) {
  const given = state.props?.[name];
  if (given !== undefined && given !== null) return given;
  const attribute = state.attrs?.[name];
  if (attribute === undefined || attribute === null) return fallback;
  return convert[Array.isArray(fallback) ? 'array' : typeof fallback](attribute);
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
