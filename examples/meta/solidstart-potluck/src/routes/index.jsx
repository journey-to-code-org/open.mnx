// The potluck page: the board, and a sign-up form. The form posts to a server action, so it
// works before (and without) JavaScript; once Solid is running it submits in place.
import { Title } from '@solidjs/meta';
import { createAsync, useSubmission } from '@solidjs/router';
import { createSignal, For, Show } from 'solid-js';
import '../../mnx/dish-board.mnx';
import '../../mnx/choice-cards.mnx';
import '../../mnx/quantity-stepper.mnx';
import { COURSES, getPotluck, signUp } from '../lib/potluck.js';

export const route = { preload: () => getPotluck() };

export default function Home() {
  const potluck = createAsync(() => getPotluck());
  const submission = useSubmission(signUp);
  const [course, setCourse] = createSignal('');
  const [guests, setGuests] = createSignal(1);
  const items = COURSES.map(({ id, title, detail }) => ({ id, title, detail }));

  return (
    <main>
      <Title>Potluck</Title>
      <h1>Saturday potluck</h1>
      <Show when={potluck()}>
        <p class="lede">{potluck().signups.length} households, {potluck().guests} people so far.</p>
        <dish-board prop:courses={potluck().courses} />
      </Show>
      <section>
        <h2>Sign up</h2>
        <Show when={submission.result?.ok}>
          <p class="notice" role="status">Thanks, {submission.result.ok}! See you Saturday.</p>
        </Show>
        <form action={signUp} method="post" class="signup">
          <label>Your name <input name="name" autocomplete="name" /></label>
          <label>Bringing <input name="dish" placeholder="What dish?" /></label>
          <choice-cards name="course" label="Course" prop:items={items} prop:value={course()} on:valuechange={(event) => setCourse(event.detail)} />
          <quantity-stepper name="guests" label="People coming" prop:min={1} prop:max={6} prop:value={guests()} on:valuechange={(event) => setGuests(event.detail)} />
          <For each={submission.result?.errors ?? []}>{(error) => <p class="error">{error}</p>}</For>
          <button disabled={submission.pending}>{submission.pending ? 'Signing up…' : 'Sign up'}</button>
        </form>
      </section>
    </main>
  );
}
