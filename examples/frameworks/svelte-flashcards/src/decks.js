// Decks, the Leitner schedule, and saving. A card is in box 1–5; each box waits longer before
// the card comes back: Again sends it to box 1, Hard keeps it, Good moves it up one, Easy two.

export const INTERVALS = [0, 1, 3, 7, 14]; // days, for boxes 1–5

export const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);

const deck = (id, name, pairs) => ({
  id,
  name,
  cards: pairs.map(([front, back], index) => ({ id: `${id}-${index + 1}`, front, back, box: 1, due: 0 })),
});

export function seed() {
  return [
    deck('es', 'Spanish basics', [
      ['la biblioteca', 'the library'],
      ['el desayuno', 'breakfast'],
      ['despacio', 'slowly'],
      ['la cuenta', 'the bill'],
      ['¿Dónde está…?', 'Where is…?'],
      ['mañana', 'tomorrow'],
      ['el sobre', 'the envelope'],
      ['tener prisa', 'to be in a hurry'],
    ]),
    deck('capitals', 'World capitals', [
      ['Australia', 'Canberra'],
      ['Canada', 'Ottawa'],
      ['Kenya', 'Nairobi'],
      ['New Zealand', 'Wellington'],
      ['Peru', 'Lima'],
      ['Vietnam', 'Hanoi'],
    ]),
    deck('web', 'Web platform', [
      ['What does ElementInternals give a custom element?', 'Form participation: value, validity, labels, states'],
      ['Which element makes a modal without JavaScript libraries?', '<dialog> with showModal()'],
      ['What does @scope limit?', 'Which elements a block of CSS applies to'],
      ['What moves a node without resetting its state?', 'moveBefore()'],
    ]),
  ];
}

/** A card after a grade (0 Again … 3 Easy). */
export function graded(card, grade, day = today()) {
  const box = grade === 0 ? 1 : Math.min(5, card.box + [0, 0, 1, 2][grade]);
  return { ...card, box, due: day + (grade === 0 ? 0 : INTERVALS[box - 1] || 1) };
}

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem('zb-flashcards'));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return seed();
}

export function save(decks) {
  try {
    localStorage.setItem('zb-flashcards', JSON.stringify(decks));
  } catch {}
}
