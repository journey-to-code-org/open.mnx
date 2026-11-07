<script>
  // A workout log: a form action (enhanced with use:enhance), whose inputs are mnx form controls,
  // and the week's progress and recent days drawn by mnx elements from the registry.
  import { enhance } from '$app/forms';
  import '../../mnx/quantity-stepper.mnx';
  import '../../mnx/star-rating.mnx';
  import '../../mnx/streak-grid.mnx';
  import '../../mnx/progress-ring.mnx';
  import '../../mnx/workout-row.mnx';

  let { data, form } = $props();
</script>

<header class="top"><strong>Reps</strong><span>workout log</span></header>
<main>
  <section class="stats">
    <div class="panel week">
      <progress-ring value={data.week} max={data.goal} label="Days trained this week"><strong>{data.week}/{data.goal}</strong></progress-ring>
      <p>days this week</p>
    </div>
    <div class="panel">
      <h2>Last 8 weeks</h2>
      <streak-grid log={data.log} today={data.today} weeks={8} goal={1} label="Workout days"></streak-grid>
    </div>
  </section>

  <form method="POST" action="?/log" class="panel log" use:enhance>
    <h2>Log a workout</h2>
    <label class="field">Exercise
      <select name="exercise" required>
        {#each data.exercises as exercise (exercise)}
          <option value={exercise} selected={form?.values?.exercise === exercise}>{exercise}</option>
        {/each}
      </select>
    </label>
    <div class="numbers">
      <div class="field">Sets <quantity-stepper name="sets" value={form?.values?.sets || 3} min={1} max={10} label="sets"></quantity-stepper></div>
      <div class="field">Reps <quantity-stepper name="reps" value={form?.values?.reps || 8} min={1} max={50} label="reps"></quantity-stepper></div>
      <div class="field">Effort <star-rating name="effort" label="Effort" required></star-rating></div>
    </div>
    {#if form?.errors}<p class="error" role="alert">{Object.values(form.errors).join(' ')}</p>{/if}
    {#if form?.logged}<p class="ok" role="status">Logged: {form.logged}.</p>{/if}
    <button class="button">Log it</button>
  </form>

  <h2>Recent</h2>
  <div class="list">
    {#each data.workouts as workout (workout.id)}
      <workout-row exercise={workout.exercise} sets={workout.sets} reps={workout.reps} effort={workout.effort} day={workout.day}></workout-row>
    {/each}
  </div>
</main>

<style>
  :global(body) { margin: 0; background: #f5f4fb; color: #1c2030; font: 15px/1.5 system-ui, sans-serif; }
  .top { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.8rem 1.5rem; background: #2e1065; color: white; }
  .top span { color: #c4b5fd; }
  main { max-width: 46rem; margin: 0 auto; padding: 1.5rem; display: grid; gap: 1rem; }
  h2 { margin: 0 0 0.6rem; font-size: 1rem; }
  .panel { padding: 1rem 1.2rem; background: white; border: 1px solid #e3e6ee; border-radius: 0.8rem; }
  .stats { display: grid; grid-template-columns: 11rem minmax(0, 1fr); gap: 1rem; }
  .week { display: grid; justify-items: center; align-content: center; }
  .week p { margin: 0.3rem 0 0; color: #61677a; }
  progress-ring { width: 7rem; --accent: #7c3aed; }
  streak-grid { --habit: #7c3aed; --cell: 1rem; }
  .log { display: grid; gap: 0.9rem; }
  .field { display: grid; gap: 0.3rem; font-weight: 600; }
  select { font: inherit; padding: 0.45rem 0.6rem; border: 1px solid #d6dae3; border-radius: 0.5rem; text-transform: capitalize; }
  .numbers { display: flex; flex-wrap: wrap; gap: 1.5rem; }
  star-rating { font-size: 1.5rem; }
  .button { justify-self: start; font: inherit; padding: 0.55rem 1.2rem; border: 0; border-radius: 0.5rem; background: #7c3aed; color: white; font-weight: 600; cursor: pointer; }
  .error { margin: 0; color: #c62f3f; }
  .ok { margin: 0; color: #15803d; font-weight: 600; }
  .list { display: grid; gap: 0.5rem; }
</style>
