# Standup

A team standup board: one card per person, edited by everyone at once, offline included. Plain Node.js, no bundler, no framework.

```sh
cargo build                 # at the repository root, once
cd examples/standup
npm install
npm start                   # http://localhost:3000; open it in two browsers
```

## What it shows

- **`standup-card.zb`** starts with `'use collection cards'`. Its `today` and `blocked` are the fields of a document keyed by its `doc` prop, kept in IndexedDB by `@zubra/sync`. Typing updates the card at once, works offline, and survives a reload; nothing in the component mentions a network.
- **`let editing = presence(false)`** is set while the card's textarea has focus, and **`let others = peers()`** lists everyone else viewing the card. "Someone else is editing this" is derived from them. Presence is never stored.
- **`server.js`** renders the page with `@zubra/server` (each card with its defaults, so the page is complete before JavaScript) and keeps the team's log with `createSyncServer({ log: await sqliteLog('standup.db') })`. `@zubra/server` serves `@zubra/sync` and maps it in the page by itself, because the cards use it. The page's one line of glue is `connect()`.

## The tests

`npm test` runs Chromium with two browser contexts as two teammates' devices: the page is complete with JavaScript off; one teammate's typing and "blocked" reach the other, along with who's editing which card; edits made offline reach the team when the device is back; and after a server restart a new device gets everything from the SQLite log.
