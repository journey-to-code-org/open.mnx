// The potluck's sign-ups, on the server (in memory), and the query and action the page uses.
import { action, query } from '@solidjs/router';

export const COURSES = [
  { id: 'main', title: 'Mains', detail: 'Something hearty', need: 3 },
  { id: 'side', title: 'Sides', detail: 'Salads, breads', need: 4 },
  { id: 'dessert', title: 'Desserts', detail: 'Sweet things', need: 2 },
  { id: 'drinks', title: 'Drinks', detail: 'Anything to pour', need: 2 },
];
const SEED = [
  { name: 'Maya', course: 'main', dish: 'Chili', guests: 2 },
  { name: 'Omar', course: 'side', dish: 'Cornbread', guests: 1 },
  { name: 'Ines', course: 'dessert', dish: 'Peach cobbler', guests: 3 },
];
const state = (globalThis.__potluck ??= { signups: SEED.map((signup) => ({ ...signup })) });

export const getPotluck = query(async () => {
  'use server';
  return {
    signups: state.signups,
    courses: COURSES.map((course) => ({ ...course, people: state.signups.filter((signup) => signup.course === course.id).map(({ name, guests }) => ({ name, guests })) })),
    guests: state.signups.reduce((sum, signup) => sum + signup.guests, 0),
  };
}, 'potluck');

export const signUp = action(async (form) => {
  'use server';
  const signup = {
    name: String(form.get('name') ?? '').trim(),
    dish: String(form.get('dish') ?? '').trim(),
    course: String(form.get('course') ?? ''),
    guests: Number(form.get('guests')),
  };
  const errors = [];
  if (!signup.name) errors.push('Your name, please.');
  if (!COURSES.some((course) => course.id === signup.course)) errors.push('Pick what you\'re bringing.');
  if (!Number.isInteger(signup.guests) || signup.guests < 1 || signup.guests > 6) errors.push('Between 1 and 6 people.');
  if (state.signups.some((existing) => existing.name.toLowerCase() === signup.name.toLowerCase())) errors.push(`${signup.name} has already signed up.`);
  if (errors.length) return { errors };
  state.signups = [...state.signups, signup];
  return { ok: signup.name };
}, 'sign-up');

export const resetPotluck = () => {
  state.signups = SEED.map((signup) => ({ ...signup }));
};
