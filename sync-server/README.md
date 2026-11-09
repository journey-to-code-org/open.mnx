# zubra-sync

The log that `'use collection'` devices share, as one binary: the same HTTP protocol as `@zubra/sync/server`, the same SQLite table as `sqliteLog()`, and no Node.js. For servers in Python, Go, PHP or anything else, or a small box of its own.

```sh
cargo build --release -p zubra-sync
./target/release/zubra-sync --db sync.db --port 4000
```

| Option | |
|---|---|
| `--db <file>` | the SQLite log (default `sync.db`); the same file `sqliteLog()` reads and writes |
| `--host`, `--port` | where to listen (default `127.0.0.1:4000`; `--port 0` picks a free one and prints it) |
| `--origin <url>` | an origin whose pages may use it directly, with CORS; repeatable |
| `--keep-alive <ms>` | how often a quiet live stream gets a keep-alive comment (default 15000) |

It has no notion of users or permissions. Put it behind your app at `/_zb/sync` (a reverse proxy, after the app's own sign-in), which also makes it same-origin for the pages, or run it on a network you trust. Pages then `connect()` as usual.

Its tests are `@zubra/sync`'s: `npm test` in `sync/` runs the protocol tests against both servers when the binary is built, and `npm run test:binary` runs the browser tests with the binary behind a proxy.
