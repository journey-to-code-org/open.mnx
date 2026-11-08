import { fail } from '@sveltejs/kit';
import { EXERCISES, add, day, perDay, thisWeek, workouts } from '#lib/server/log.js';

export function load() {
  return { workouts: workouts().slice(0, 12).map((workout) => ({ ...workout, day: day(workout.at) })), log: perDay(), today: day(Date.now()), week: thisWeek(), goal: 4, exercises: EXERCISES };
}

export const actions = {
  // The steppers and the effort rating are zubra form controls: their values arrive in the form
  // data under their names, like native inputs'.
  log: async ({ request }) => {
    const form = await request.formData();
    const values = { exercise: String(form.get('exercise') ?? ''), sets: Number(form.get('sets')), reps: Number(form.get('reps')), effort: Number(form.get('effort')) };
    const errors = {};
    if (!EXERCISES.includes(values.exercise)) errors.exercise = 'Choose an exercise.';
    if (!(Number.isInteger(values.sets) && values.sets >= 1 && values.sets <= 10)) errors.sets = 'Sets: 1 to 10.';
    if (!(Number.isInteger(values.reps) && values.reps >= 1 && values.reps <= 50)) errors.reps = 'Reps: 1 to 50.';
    if (!(values.effort >= 1 && values.effort <= 5)) errors.effort = 'Rate the effort.';
    if (Object.keys(errors).length) return fail(400, { errors, values });
    add(values);
    return { logged: `${values.exercise}, ${values.sets} × ${values.reps}` };
  },
};
