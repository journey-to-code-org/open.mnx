// The site's recipes. Amounts are for `servings` people; the scaler multiplies them.
export const recipes = [
  {
    id: 'shakshuka',
    title: 'Shakshuka',
    summary: 'Eggs poached in a spiced tomato and pepper sauce.',
    minutes: 30,
    servings: 2,
    tags: ['vegetarian', 'one pan'],
    ingredients: [
      { name: 'eggs', amount: 4, unit: '' },
      { name: 'chopped tomatoes', amount: 400, unit: 'g' },
      { name: 'red pepper', amount: 1, unit: '' },
      { name: 'onion', amount: 1, unit: '' },
      { name: 'cumin', amount: 1, unit: 'tsp' },
      { name: 'olive oil', amount: 2, unit: 'tbsp' },
    ],
    steps: [
      'Soften the onion and pepper in the oil, about 8 minutes.',
      'Add the cumin, then the tomatoes; simmer until thick, about 10 minutes.',
      'Make hollows, crack in the eggs, cover and cook until the whites set.',
    ],
  },
  {
    id: 'dal',
    title: 'Red lentil dal',
    summary: 'A weeknight dal: lentils, ginger and a quick tempered spice oil.',
    minutes: 40,
    servings: 4,
    tags: ['vegan'],
    ingredients: [
      { name: 'red lentils', amount: 250, unit: 'g' },
      { name: 'water', amount: 1, unit: 'l' },
      { name: 'ginger, grated', amount: 2, unit: 'tsp' },
      { name: 'turmeric', amount: 1, unit: 'tsp' },
      { name: 'mustard seeds', amount: 1, unit: 'tsp' },
      { name: 'neutral oil', amount: 2, unit: 'tbsp' },
    ],
    steps: [
      'Rinse the lentils and simmer with the water, ginger and turmeric for 25 minutes.',
      'Heat the oil, add the mustard seeds and let them pop.',
      'Pour the oil over the dal and season.',
    ],
  },
  {
    id: 'flatbreads',
    title: 'Yogurt flatbreads',
    summary: 'Two-ingredient dough, cooked in a dry pan in minutes.',
    minutes: 20,
    servings: 6,
    tags: ['vegetarian', 'quick'],
    ingredients: [
      { name: 'self-raising flour', amount: 300, unit: 'g' },
      { name: 'plain yogurt', amount: 300, unit: 'g' },
      { name: 'salt', amount: 0.5, unit: 'tsp' },
    ],
    steps: [
      'Mix everything into a soft dough and divide it into pieces.',
      'Roll each piece thin.',
      'Cook in a hot dry pan for a minute or two a side.',
    ],
  },
];

export const byId = (id) => recipes.find((recipe) => recipe.id === id);
