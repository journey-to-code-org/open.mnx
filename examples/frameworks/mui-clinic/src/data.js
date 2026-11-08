export const doctors = [
  { id: 'okafor', name: 'Dr. Amara Okafor', specialty: 'General practice', next: 'Today', rating: 4.9 },
  { id: 'lindqvist', name: 'Dr. Erik Lindqvist', specialty: 'Dermatology', next: 'Tomorrow', rating: 4.7 },
  { id: 'tanaka', name: 'Dr. Yui Tanaka', specialty: 'Paediatrics', next: 'Thursday', rating: 4.8 },
];

export const days = ['Mon 9', 'Tue 10', 'Wed 11', 'Thu 12', 'Fri 13'];

const TIMES = ['08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'];

/** A doctor's times on a day; some are taken (the same ones every time, for the demo). */
export function slotsFor(doctor, day) {
  if (!doctor || !day) return [];
  const seed = [...`${doctor}${day}`].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return TIMES.map((time, index) => ({ time, taken: (seed + index * 7) % 5 === 0 }));
}
