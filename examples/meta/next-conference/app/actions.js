'use server';
// The feedback form's Server Action. The star rating and the switch are mnx form controls
// (form-associated custom elements), so their values arrive in FormData like any input's.
import { revalidatePath } from 'next/cache';
import { addFeedback } from '@/lib/feedback.js';
import { findSession } from '@/lib/sessions.js';

export async function submitFeedback(previous, form) {
  const session = findSession(String(form.get('session')));
  if (!session) return { ok: false, message: 'That session no longer exists.' };
  const rating = Number(form.get('rating'));
  if (!(rating >= 1 && rating <= 5)) return { ok: false, message: 'Pick a rating from 1 to 5 stars.' };
  addFeedback(session.id, { rating, comment: String(form.get('comment') ?? '').slice(0, 1000), followup: form.get('followup') === 'on' });
  revalidatePath(`/sessions/${session.id}`);
  return { ok: true, message: `Thanks! You rated it ${rating} of 5.` };
}
