# Help desk: Express, EJS and MongoDB, with mnx components

A ticket tracker for a support team. Customers file tickets and follow the conversation. Agents work a queue, reply, leave internal notes, change status and priority, assign tickets and watch response deadlines.

It's an ordinary Node server app: Express routes, EJS templates, MongoDB. The interactive parts are mnx components, and it uses them the way mnx is meant to work on a server:

| Promise | Here |
|---|---|
| **Server-rendered first** | Each page's components are rendered to HTML on the request by `@mnx/server` (Express middleware over `@mnx/compiler`), inside the EJS templates: `<%- mnx('ticket-table', { tickets }) %>`. The SLA timers' "due in 2h 30m" is in that HTML, worked out on the server from the request's time rather than filled in later. |
| **Hydrated, not re-rendered** | The browser loads each component's module and binds it to the markup that's already there. The test checks that a table row is the same DOM node before and after. |
| **Works without JavaScript** | The components render native form elements in light DOM (radio buttons, selects, a textarea), so filing a ticket, replying, filtering and updating all work as plain HTML forms. The test runs the whole flow with JavaScript turned off. |
| **Then better with it** | J/K/Enter moves through the queue. Filters apply as you choose them. The reply box counts characters, waits for text and sends on Ctrl+Enter. Priorities highlight as you pick them. SLA timers keep counting. |
| **No bundler** | `/_mnx/components/<name>.js` is each component compiled on request, and an import map points `@mnx/runtime` at the runtime's own modules (both served by `@mnx/server`). A page loads only the components it rendered. |
| **Components you own** | The dashboard's donut chart and spark line came from the registry: `npx mnx add donut-chart spark-line --dir components`. |

## Run it

```sh
npm install
npm start                      # http://localhost:3000, in-memory data
MONGODB_URI=mongodb://localhost:27017/helpdesk npm start   # with MongoDB (seeded on first start)
```

Sign in as anyone on the list: Ada and Sam are agents; Lena, Raj and Tom are customers.

### The compiler

The server renders components with `@mnx/compiler`, which includes the compiler when it's installed from npm. Inside this repository it has to be built first, and `npm start` checks for it (`scripts/ensure-compiler.js`):

- **With Rust installed**, `npm start` runs `cargo build` at the repository root the first time, and uses that CLI (`target/debug/mnx`, or `mnx.exe` on Windows).
- **Without Rust**, download `mnx.wasm` instead: GitHub → Actions → CI → the latest run on `main` → Artifacts → `mnx-wasm`. Unzip it into `compiler/` (as `compiler/mnx.wasm`), then `npm start`.
- `MNX_COMPILER=/path/to/mnx` points at a CLI anywhere else.

If none of these is there, `npm start` stops and says so, rather than serving error pages.

## How it fits together

```text
server.js              starts the app with a store
src/app.js             routes; renders a view, then the layout, and finish() adds the CSS and modules
                       it used (@mnx/server/express: res.locals.mnx)
src/auth.js            sign-in as a signed cookie
src/store/             memory.js and mongo.js, one interface (seed.js has the demo data)
views/*.ejs            the pages
components/*.mnx       status-badge, priority-picker, sla-timer, ticket-table, filter-bar,
                       ticket-thread, reply-composer; donut-chart and spark-line from the registry
```

A view runs before the layout, so the layout knows which components the page used. Their CSS goes in the `<head>` (no flash of unstyled components), and their modules go at the end of the page. Components that use other components (the table's badges and timers) render them inline and import their modules.

## Tests

```sh
npm test                                          # in-memory store
MONGODB_URI=mongodb://localhost:27017 npm test    # MongoDB
```

- `test/store.test.js` checks the store contract (filters, search, sequential ids, internal notes kept out of search, stats) against each store.
- `test/app.test.js` drives Chromium through every page twice: once with JavaScript off, and once with it on (hydration, keyboard, live filters, the reply box, internal notes hidden from customers, a running SLA timer with a fake clock).

CI runs both, the second against a MongoDB service container.
