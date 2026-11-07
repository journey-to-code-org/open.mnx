'use client';
// Feedback through a Server Action. The rating and the switch are mnx form controls: they take
// part in the form like native inputs (FormData, validation, reset), so the action just reads
// `rating` and `followup`.
import { useActionState } from 'react';
import StarRating from '../../../components/star-rating.mnx';
import ToggleSwitch from '../../../components/toggle-switch.mnx';
import { submitFeedback } from '@/app/actions.js';

export default function FeedbackForm({ session }) {
  const [state, action, pending] = useActionState(submitFeedback, null);
  return (
    <form action={action} className="feedback">
      <h2>How was it?</h2>
      <input type="hidden" name="session" value={session} />
      <StarRating name="rating" label="Your rating" required />
      <label className="field">Anything to add?
        <textarea name="comment" rows={3} maxLength={1000} />
      </label>
      <ToggleSwitch name="followup" label="Follow up with me" description="The speaker may email you about the talk." />
      <div className="row">
        <button className="button" disabled={pending}>{pending ? 'Sending…' : 'Send feedback'}</button>
        {state && <p role="status" className={state.ok ? 'ok' : 'bad'}>{state.message}</p>}
      </div>
    </form>
  );
}
