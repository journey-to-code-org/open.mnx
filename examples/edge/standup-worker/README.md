# Standup board on a Cloudflare Worker

The board from [`../../standup`](../../standup), plus a "Lead today" form, served by a Worker with no server of its own. It's the proof for Sync and Actions on Workers:

| | Node.js (`examples/standup`) | Worker (`src/worker.js`) |
|---|---|---|
| Sync server | `createSyncServer` in the process | a Durable Object: `Board extends SyncObject` (`src/board.js`) |
| Log | `sqliteLog('standup.db')` | `durableObjectLog`: the object's own SQLite |
| Server functions | `createActions({ components })`, compiled at start-up | `zubra-actions build` → `src/actions/`, served by `@zubra/actions/edge` |
| Pages | `@zubra/server` | `@zubra/server/edge` |
| Browser modules | served from `node_modules` | static assets (`npm run build`) |

The lead picker's server function calls `board.lead(name)`, a method on the Durable Object: the object runs one call at a time, so two people pressing "Lead today" together can't both win.

```sh
npm install
npm run dev     # builds the actions and assets, then wrangler dev --local
npm test        # workerd + Chromium
```

The tests run the Worker in workerd with two browser contexts:
- the page is complete before JavaScript;
- typing and presence reach the other teammate through the object;
- two people race for the lead, and the object decides;
- the form works without JavaScript, and its answer comes back on the page;
- the log survives the Worker restarting.

`test/contract.test.js` also runs `@zubra/sync`'s log contract inside a Durable Object, on workerd's own storage.
