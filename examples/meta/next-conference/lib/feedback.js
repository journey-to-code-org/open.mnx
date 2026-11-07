// Feedback, kept in the server's memory (a real app would use a database).
const store = globalThis.__feedback ??= new Map();

export function addFeedback(sessionId, entry) {
  const list = store.get(sessionId) ?? [];
  list.push({ ...entry, at: Date.now() });
  store.set(sessionId, list);
}

export function summary(sessionId) {
  const list = store.get(sessionId) ?? [];
  const average = list.length ? list.reduce((sum, entry) => sum + entry.rating, 0) / list.length : 0;
  return { count: list.length, average: Math.round(average * 10) / 10, followups: list.filter((entry) => entry.followup).length };
}
