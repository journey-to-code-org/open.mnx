// The store: MongoDB when MONGODB_URI is set, in memory otherwise.
import { memoryStore } from './memory.js';

export async function createStore(uri = process.env.MONGODB_URI) {
  if (!uri) return memoryStore();
  const { mongoStore } = await import('./mongo.js');
  return mongoStore(uri);
}
