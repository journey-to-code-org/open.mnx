// The in-memory store: the same interface as the MongoDB one, for development and tests.
import { USERS, seedTickets } from './seed.js';
import { matches, statsOf } from './query.js';

export function memoryStore() {
  const users = structuredClone(USERS);
  let tickets = seedTickets();
  let nextId = Math.max(...tickets.map((ticket) => ticket.id)) + 1;
  const copy = (value) => structuredClone(value);
  return {
    kind: 'memory',
    async listUsers() { return copy(users); },
    async getUser(id) { return copy(users.find((user) => user.id === id) ?? null); },
    async listTickets(filter = {}) {
      return copy(tickets.filter((ticket) => matches(ticket, filter)).sort((a, b) => b.updatedAt - a.updatedAt));
    },
    async getTicket(id) { return copy(tickets.find((ticket) => ticket.id === id) ?? null); },
    async createTicket(ticket) {
      const created = { ...copy(ticket), id: nextId++ };
      tickets.push(created);
      return created.id;
    },
    async addMessage(id, message, changes = {}) {
      const ticket = tickets.find((item) => item.id === id);
      if (!ticket) return false;
      ticket.messages.push(copy(message));
      Object.assign(ticket, copy(changes), { updatedAt: message.at });
      return true;
    },
    async updateTicket(id, changes) {
      const ticket = tickets.find((item) => item.id === id);
      if (!ticket) return false;
      Object.assign(ticket, copy(changes));
      return true;
    },
    async stats(now = Date.now()) { return statsOf(tickets, now); },
    async reset() {
      tickets = seedTickets();
      nextId = Math.max(...tickets.map((ticket) => ticket.id)) + 1;
    },
    async close() {},
  };
}
