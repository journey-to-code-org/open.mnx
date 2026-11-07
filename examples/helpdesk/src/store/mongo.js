// The MongoDB store. Tickets are documents with their messages embedded; ids are sequential
// numbers from a counter document, as help desks number tickets.
import { MongoClient } from 'mongodb';
import { USERS, seedTickets } from './seed.js';
import { statsOf } from './query.js';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip = (document) => {
  if (!document) return null;
  const { _id, ...rest } = document;
  return rest;
};

export async function mongoStore(uri, { database } = {}) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(database);
  const users = db.collection('users');
  const tickets = db.collection('tickets');
  const counters = db.collection('counters');

  async function seed() {
    await Promise.all([users.deleteMany({}), tickets.deleteMany({}), counters.deleteMany({})]);
    const seeded = seedTickets();
    await users.insertMany(USERS.map((user) => ({ ...user })));
    await tickets.insertMany(seeded);
    await counters.insertOne({ _id: 'ticket', value: Math.max(...seeded.map((ticket) => ticket.id)) });
  }
  if ((await users.countDocuments()) === 0) await seed();
  await tickets.createIndex({ id: 1 }, { unique: true });
  await tickets.createIndex({ updatedAt: -1 });

  return {
    kind: 'mongodb',
    async listUsers() { return (await users.find().toArray()).map(strip); },
    async getUser(id) { return strip(await users.findOne({ id })); },
    async listTickets({ status, priority, q, requester } = {}) {
      const query = {};
      if (status) query.status = status;
      if (priority) query.priority = priority;
      if (requester) query.requester = requester;
      if (q) {
        const pattern = new RegExp(escape(q), 'i');
        query.$or = [{ subject: pattern }, { messages: { $elemMatch: { body: pattern, internal: false } } }];
      }
      return (await tickets.find(query).sort({ updatedAt: -1 }).toArray()).map(strip);
    },
    async getTicket(id) { return strip(await tickets.findOne({ id })); },
    async createTicket(ticket) {
      // The document after the increment (drivers before 6 wrap it in `{ value }`).
      const result = await counters.findOneAndUpdate({ _id: 'ticket' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
      const counter = result && 'lastErrorObject' in result ? result.value : result;
      await tickets.insertOne({ ...ticket, id: counter.value });
      return counter.value;
    },
    async addMessage(id, message, changes = {}) {
      const result = await tickets.updateOne({ id }, { $push: { messages: message }, $set: { ...changes, updatedAt: message.at } });
      return result.matchedCount === 1;
    },
    async updateTicket(id, changes) {
      const result = await tickets.updateOne({ id }, { $set: changes });
      return result.matchedCount === 1;
    },
    async stats(now = Date.now()) {
      return statsOf(await tickets.find({}, { projection: { status: 1, createdAt: 1, dueAt: 1 } }).toArray(), now);
    },
    reset: seed,
    close: () => client.close(),
  };
}
