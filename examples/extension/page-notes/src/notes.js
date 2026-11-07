// Notes in chrome.storage.local, per site (an origin): `notes:<origin>` is that site's notes,
// newest first, and `settings` is `{ widget, color, hidden: [origins] }`.
export const DEFAULTS = { widget: true, color: '#16a34a', hidden: [] };
const key = (origin) => `notes:${origin}`;

export async function load(origin) {
  return (await chrome.storage.local.get(key(origin)))[key(origin)] ?? [];
}
export async function save(origin, notes) {
  await chrome.storage.local.set({ [key(origin)]: notes });
}
export async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get('settings')).settings };
}
export async function saveSettings(changes) {
  await chrome.storage.local.set({ settings: { ...(await settings()), ...changes } });
}
export async function all() {
  const items = await chrome.storage.local.get(null);
  return Object.fromEntries(Object.entries(items).filter(([name]) => name.startsWith('notes:')).map(([name, notes]) => [name.slice(6), notes]));
}
/** The origin notes are kept under, or null for pages that can't have them (chrome://, files). */
export function originOf(url) {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? origin : null;
  } catch {
    return null;
  }
}
