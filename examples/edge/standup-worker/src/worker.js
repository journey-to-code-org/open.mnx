// The standup board (examples/standup) on a Cloudflare Worker, with nothing of its own to run:
//   - @zubra/sync's server is a Durable Object (src/board.js), its log in the object's SQLite; the
//     Worker forwards /_zb/sync/* to it and reads the documents from it to render the page;
//   - the lead picker's 'use server' function is built ahead of time (npm run build →
//     src/actions/) and answered by @zubra/actions/edge, the Node entry's code;
//   - pages come from @zubra/server/edge; the runtime, @zubra/sync's browser modules and the
//     actions script are static assets.
import wasm from '@zubra/compiler/zubra.wasm';
import { createZubra } from '@zubra/server/edge';
import { createActions } from '@zubra/actions/edge';
import { syncStub } from '@zubra/sync/durable';
import { actions } from './actions/index.js';
import standupCard from '../../../standup/components/standup-card.zb';
import leadPicker from '../components/lead-picker.zb';

export { Board } from './board.js';

export const team = [
  { doc: 'ada', name: 'Ada' },
  { doc: 'grace', name: 'Grace' },
  { doc: 'linus', name: 'Linus' },
];

const zubra = createZubra({
  wasm,
  components: { 'standup-card': standupCard, 'lead-picker': leadPicker },
  imports: { '@zubra/sync': '/_zubra/sync/index.js', '@zubra/sync/connect': '/_zubra/sync/connect.js' },
});
// The server function gets the board's object, to call `lead()` on.
const forms = createActions({ actions, context: ({ env }) => ({ board: syncStub(env.BOARD).stub }) });

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export default {
  async fetch(request, env) {
    const sync = syncStub(env.BOARD);
    const answered = (await sync.fetch(request)) ?? (await forms.fetch(request, { env })) ?? (await zubra.fetch(request));
    if (answered) return answered;
    if (new URL(request.url).pathname !== '/') return new Response('Not found', { status: 404 });

    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
    const result = forms.result(request, (name, value) => headers.append(name, value));
    const docs = await sync.documents('meta');
    const page = zubra.page();
    const picker = page.render('lead-picker', { doc: 'today', current: docs.get('meta', 'today')?.lead ?? '', notice: result?.value?.error ?? '' });
    const cards = team.map((person) => page.render('standup-card', person)).join('\n');
    return new Response(page.finish(`<!doctype html>
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
  <h1>${escape('Standup')}</h1>
  ${picker}
  <main>${cards}</main>
  ${forms.script()}
  <script type="module">
    import { connect } from '@zubra/sync/connect';
    connect();
  </script>
</body>
</html>`), { headers });
  },
};
