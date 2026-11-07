// `npm start`: the help desk on http://localhost:3000 (PORT), with MongoDB when MONGODB_URI is
// set and an in-memory store otherwise.
import { createApp } from './src/app.js';
import { createStore } from './src/store/index.js';

const store = await createStore();
const app = createApp({ store, cache: process.env.NODE_ENV === 'production' });
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`help desk on http://localhost:${port} (${store.kind} store)`));
