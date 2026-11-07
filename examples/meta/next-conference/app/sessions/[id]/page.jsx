import { notFound } from 'next/navigation';
import { summary } from '@/lib/feedback.js';
import { findSession } from '@/lib/sessions.js';
import FeedbackForm from './FeedbackForm.jsx';

export const dynamic = 'force-dynamic';

export default async function Session({ params }) {
  const { id } = await params;
  const session = findSession(id);
  if (!session) notFound();
  const { count, average, followups } = summary(session.id);
  return (
    <article className="session">
      <p className="muted"><a href="/">Schedule</a> / {session.day} {session.start}</p>
      <h1>{session.title}</h1>
      <p className="meta">{session.speaker} · {session.room} · {session.start}–{session.end} · <span data-track={session.track}>{session.track}</span></p>
      <p className="ratings" data-testid="ratings">
        {count ? `${average} ★ from ${count} rating${count === 1 ? '' : 's'}` : 'No ratings yet'}
        {followups ? ` · ${followups} want a follow-up` : ''}
      </p>
      <FeedbackForm session={session.id} />
    </article>
  );
}
