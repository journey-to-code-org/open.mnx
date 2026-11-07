// The help desk: Express routes, EJS views, mnx components rendered on the server and hydrated
// in the browser, and a store (MongoDB or memory).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import express from 'express';
import { sessions } from './auth.js';
import { createMnx } from './mnx.js';
import { SLA_HOURS } from './store/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const VIEWS = join(here, '../views');
const STATUSES = ['open', 'pending', 'solved'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const HOUR = 3_600_000;

const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
function ago(at, now) {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

export function createApp({ store, cache = true, now = () => Date.now() }) {
  const app = express();
  const auth = sessions();
  const mnx = createMnx({ cache });

  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(join(here, '../public')));
  app.use(mnx.router);
  app.use(auth.middleware(store));

  /**
   * Render `view` inside the layout. The view runs first, so the layout knows which components
   * the page used: their CSS goes in the head, and their modules are loaded at the end.
   */
  async function page(res, view, locals = {}, status = 200) {
    const components = mnx.page();
    const data = { ...res.locals, ...locals, mnx: components.render, user: res.locals.user };
    const body = await ejs.renderFile(join(VIEWS, `${view}.ejs`), data, { async: false });
    const html = await ejs.renderFile(join(VIEWS, 'layout.ejs'), { ...data, body, styles: components.css(), modules: [...components.used] });
    res.status(status).type('html').send(html);
  }

  const requireUser = (req, res, next) => (req.user ? next() : res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`));
  const requireAgent = (req, res, next) => (req.user?.role === 'agent' ? next() : res.status(403).send('Agents only'));

  // Display shapes for the components.
  const names = async () => Object.fromEntries((await store.listUsers()).map((user) => [user.id, user]));
  const row = (ticket, people, at) => ({
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    requester: people[ticket.requester]?.name ?? '?',
    assignee: people[ticket.assignee]?.name ?? 'Unassigned',
    updated: ago(ticket.updatedAt, at),
    due: ticket.dueAt,
    now: at,
    solved: ticket.status === 'solved',
    href: `/tickets/${ticket.id}`,
  });
  const visible = (req, ticket) => req.user.role === 'agent' || ticket.requester === req.user.id;

  app.get('/login', async (req, res) => {
    await page(res, 'login', { title: 'Sign in', people: await store.listUsers(), next: req.query.next ?? '/' });
  });
  app.post('/login', async (req, res) => {
    const user = await store.getUser(req.body.user);
    if (!user) return res.redirect(303, '/login');
    auth.signIn(res, user.id);
    const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
    res.redirect(303, next);
  });
  app.post('/logout', (req, res) => {
    auth.signOut(res);
    res.redirect(303, '/login');
  });

  app.get('/', requireUser, async (req, res) => {
    const at = now();
    const people = await names();
    if (req.user.role === 'customer') {
      const mine = await store.listTickets({ requester: req.user.id });
      return page(res, 'home', { title: 'Your tickets', tickets: mine.map((ticket) => row(ticket, people, at)) });
    }
    const stats = await store.stats(at);
    const queue = (await store.listTickets({})).filter((ticket) => ticket.status !== 'solved' && (ticket.assignee === req.user.id || !ticket.assignee));
    await page(res, 'dashboard', {
      title: 'Dashboard',
      stats,
      segments: [
        { label: 'Open', value: stats.byStatus.open, tone: 0 },
        { label: 'Pending', value: stats.byStatus.pending, tone: 2 },
        { label: 'Solved', value: stats.byStatus.solved, tone: 3 },
      ],
      queue: queue.map((ticket) => row(ticket, people, at)),
    });
  });

  app.get('/tickets', requireUser, async (req, res) => {
    const filter = {
      status: STATUSES.includes(req.query.status) ? req.query.status : '',
      priority: PRIORITIES.includes(req.query.priority) ? req.query.priority : '',
      q: typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '',
    };
    const at = now();
    const people = await names();
    const found = await store.listTickets({ ...filter, requester: req.user.role === 'customer' ? req.user.id : undefined });
    await page(res, 'tickets', { title: 'Tickets', filter, tickets: found.map((ticket) => row(ticket, people, at)) });
  });

  app.get('/tickets/new', requireUser, async (req, res) => {
    await page(res, 'new', { title: 'New ticket', values: { subject: '', body: '', priority: 'normal' }, errors: {} });
  });
  app.post('/tickets', requireUser, async (req, res) => {
    const values = {
      subject: String(req.body.subject ?? '').trim(),
      body: String(req.body.body ?? '').trim(),
      priority: PRIORITIES.includes(req.body.priority) ? req.body.priority : 'normal',
    };
    const errors = {};
    if (values.subject.length < 5) errors.subject = 'Give the ticket a subject of at least 5 characters.';
    if (values.subject.length > 120) errors.subject = 'Keep the subject under 120 characters.';
    if (!values.body) errors.body = 'Describe the problem.';
    if (Object.keys(errors).length) return page(res, 'new', { title: 'New ticket', values, errors }, 422);
    const at = now();
    const id = await store.createTicket({
      subject: values.subject,
      requester: req.user.id,
      assignee: null,
      priority: values.priority,
      status: 'open',
      createdAt: at,
      updatedAt: at,
      dueAt: at + SLA_HOURS[values.priority] * HOUR,
      messages: [{ id: `m${at.toString(36)}`, author: req.user.id, body: values.body, at, internal: false }],
    });
    res.redirect(303, `/tickets/${id}`);
  });

  app.get('/tickets/:id', requireUser, async (req, res, next) => {
    const ticket = await store.getTicket(Number(req.params.id));
    if (!ticket || !visible(req, ticket)) return next();
    const at = now();
    const people = await names();
    const agent = req.user.role === 'agent';
    const messages = ticket.messages
      .filter((message) => agent || !message.internal)
      .map((message) => ({
        id: message.id,
        author: people[message.author]?.name ?? '?',
        role: people[message.author]?.role ?? 'customer',
        body: message.body,
        at: when.format(message.at),
        internal: message.internal,
      }));
    await page(res, 'ticket', {
      title: `#${ticket.id} ${ticket.subject}`,
      ticket: row(ticket, people, at),
      messages,
      agent,
      agents: (await store.listUsers()).filter((user) => user.role === 'agent'),
      assigneeId: ticket.assignee ?? '',
      updated: req.query.updated === '1',
    });
  });

  app.post('/tickets/:id/replies', requireUser, async (req, res, next) => {
    const id = Number(req.params.id);
    const ticket = await store.getTicket(id);
    if (!ticket || !visible(req, ticket)) return next();
    const body = String(req.body.body ?? '').trim();
    if (!body) return res.redirect(303, `/tickets/${id}`);
    const agent = req.user.role === 'agent';
    const internal = agent && req.body.internal === 'on';
    const at = now();
    // A public reply from the support side waits on the customer; one from the customer reopens.
    const status = internal ? ticket.status : agent ? 'pending' : 'open';
    await store.addMessage(id, { id: `m${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, author: req.user.id, body: body.slice(0, 4000), at, internal }, { status });
    res.redirect(303, `/tickets/${id}#latest`);
  });

  app.post('/tickets/:id', requireUser, requireAgent, async (req, res, next) => {
    const id = Number(req.params.id);
    const ticket = await store.getTicket(id);
    if (!ticket) return next();
    const changes = {};
    if (STATUSES.includes(req.body.status)) changes.status = req.body.status;
    if (PRIORITIES.includes(req.body.priority) && req.body.priority !== ticket.priority) {
      changes.priority = req.body.priority;
      changes.dueAt = ticket.createdAt + SLA_HOURS[req.body.priority] * HOUR;
    }
    if (typeof req.body.assignee === 'string') {
      const assignee = req.body.assignee ? await store.getUser(req.body.assignee) : null;
      if (!req.body.assignee || assignee?.role === 'agent') changes.assignee = assignee?.id ?? null;
    }
    changes.updatedAt = now();
    await store.updateTicket(id, changes);
    res.redirect(303, `/tickets/${id}?updated=1`);
  });

  app.use(async (req, res) => {
    await page(res, 'error', { title: 'Not found', message: "That page doesn't exist, or it isn't yours to see." }, 404);
  });
  app.use(async (error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    // In development, say what: it's usually something to fix in a view or a component.
    const detail = process.env.NODE_ENV === 'production' ? '' : `\n\n${error.stack ?? error}`;
    res.status(500).type('text').send(`Something went wrong.${detail}`);
  });
  return app;
}
