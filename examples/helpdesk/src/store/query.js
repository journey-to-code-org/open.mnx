// Filtering and statistics shared by the stores (the MongoDB store filters in the database,
// with the same meaning).

export function matches(ticket, { status, priority, q, requester } = {}) {
  if (status && ticket.status !== status) return false;
  if (priority && ticket.priority !== priority) return false;
  if (requester && ticket.requester !== requester) return false;
  if (q) {
    const needle = q.toLowerCase();
    const haystack = [ticket.subject, ...ticket.messages.filter((message) => !message.internal).map((message) => message.body)];
    if (!haystack.some((text) => text.toLowerCase().includes(needle))) return false;
  }
  return true;
}

const DAY = 86_400_000;

/** Counts by status, and tickets opened per day over the last 14 days (oldest first). */
export function statsOf(tickets, now) {
  const byStatus = { open: 0, pending: 0, solved: 0 };
  for (const ticket of tickets) byStatus[ticket.status] += 1;
  const today = Math.floor(now / DAY);
  const perDay = Array.from({ length: 14 }, (_, index) => tickets.filter((ticket) => Math.floor(ticket.createdAt / DAY) === today - 13 + index).length);
  const overdue = tickets.filter((ticket) => ticket.status !== 'solved' && ticket.dueAt < now).length;
  return { byStatus, perDay, overdue, total: tickets.length };
}
