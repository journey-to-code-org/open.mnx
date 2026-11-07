// The shop's inventory, in memory: bikes, parts and accessories.
const SEED = [
  ['Trail 29 hardtail', 'bikes', 129900, 4, ['mtb', '29"']],
  ['City 7-speed', 'bikes', 64900, 2, ['commuter']],
  ['Gravel 105', 'bikes', 189900, 1, ['gravel', 'carbon fork']],
  ['Kids 20" balance', 'bikes', 21900, 6, ['kids']],
  ['Cargo longtail', 'bikes', 279900, 0, ['cargo', 'e-assist']],
  ['Road disc 2×12', 'bikes', 239900, 3, ['road']],
  ['Folding 16"', 'bikes', 99900, 2, ['commuter', 'folding']],
  ['Tube 700×28', 'parts', 899, 40, ['presta']],
  ['Tube 29×2.4', 'parts', 1099, 18, ['schrader']],
  ['Chain 12-speed', 'parts', 4999, 7, ['drivetrain']],
  ['Cassette 11–34', 'parts', 8999, 3, ['drivetrain']],
  ['Brake pads (resin)', 'parts', 1999, 12, ['brakes']],
  ['Rotor 180 mm', 'parts', 4499, 5, ['brakes']],
  ['Bar tape', 'parts', 2499, 9, ['road']],
  ['Grips, lock-on', 'parts', 2999, 2, ['mtb']],
  ['Tire 29×2.4 TR', 'parts', 7499, 6, ['mtb', 'tubeless']],
  ['Sealant 500 ml', 'parts', 2299, 0, ['tubeless']],
  ['Helmet MIPS M', 'accessories', 11999, 4, ['safety']],
  ['Helmet MIPS L', 'accessories', 11999, 1, ['safety']],
  ['Front light 800 lm', 'accessories', 5999, 8, ['lights', 'usb-c']],
  ['Rear light', 'accessories', 2999, 11, ['lights']],
  ['U-lock + cable', 'accessories', 6999, 3, ['security']],
  ['Floor pump', 'accessories', 4999, 5, ['tools']],
  ['Multi-tool 18', 'accessories', 3499, 7, ['tools']],
  ['Bottle cage', 'accessories', 1299, 22, []],
  ['Pannier pair', 'accessories', 12999, 2, ['touring']],
];

export const CATEGORIES = ['bikes', 'parts', 'accessories'];

export function createStore() {
  let items = [];
  const reset = () => {
    items = SEED.map(([name, category, cents, count, tags], index) => ({ id: index + 1, name, category, cents, count, tags: [...tags], reorder: category === 'bikes' ? 1 : 3 }));
  };
  reset();
  return {
    reset,
    get: (id) => items.find((item) => item.id === id),
    /** Matching items, a page at a time: `{ items, more }`. */
    list({ q = '', category = '', page = 1, size = 10 } = {}) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const found = items.filter((item) =>
        (!category || item.category === category) &&
        words.every((word) => item.name.toLowerCase().includes(word) || item.tags.includes(word)));
      return { items: found.slice((page - 1) * size, page * size), more: found.length > page * size, total: found.length };
    },
    update(id, changes) {
      const item = items.find((entry) => entry.id === id);
      Object.assign(item, changes);
      return item;
    },
    sell(id) {
      const item = items.find((entry) => entry.id === id);
      if (item.count > 0) item.count -= 1;
      return item;
    },
    low: () => items.filter((item) => item.count <= item.reorder).length,
  };
}
