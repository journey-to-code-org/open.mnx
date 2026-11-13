// A team standup board: one card per person, edited by everyone at once, offline included.
//
// Each card's state lives in the browser first (IndexedDB, through @zubra/sync), so typing never
// waits on the network. connect() shares it with the team through this server's log, a SQLite
// file, and shows who else is editing a card. The page is rendered on the server with the cards'
// defaults; each card loads its document once it starts.
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createSyncServer, allowAnyone } from '@zubra/sync/server';
import { sqliteLog } from '@zubra/sync/sqlite';

const here = dirname(fileURLToPath(import.meta.url));
export const team = [
  { doc: 'ada', name: 'Ada' },
  { doc: 'grace', name: 'Grace' },
  { doc: 'linus', name: 'Linus' },
];

export async function createApp({ db = join(here, 'standup.db'), cache = true } = {}) {
  const log = await sqliteLog(db);
  // Everyone who can open the board may edit any card: the team's own board on a trusted network.
  // An app on the open internet says who may change what instead (authorize, docs/sync.md).
  const sync = createSyncServer({ log, authorize: allowAnyone });
  // The cards start with 'use collection', so they import @zubra/sync: @zubra/server finds it in
  // node_modules, serves it, and puts it in the page's import map.
  const zubra = createZubra({ components: join(here, 'components'), cache });

  const server = createServer(async (req, res) => {
    if (await sync.handle(req, res)) return;
    if (zubra.handle(req, res)) return;
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/') return res.writeHead(404).end('Not found');
    const page = zubra.page();
    const cards = team.map((person) => page.render('standup-card', person)).join('\n');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page.finish(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Standup</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
  </style>
</head>
<body>
  <h1>Standup</h1>
  <main>${cards}</main>
  <script type="module">
    import { connect } from '@zubra/sync/connect';
    connect();
  </script>
</body>
</html>`));
  });
  server.on('close', () => log.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  (await createApp()).listen(port, () => console.log(`Standup on http://localhost:${port}`));
}
