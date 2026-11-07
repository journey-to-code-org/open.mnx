// A simulated market: a seeded random walk per symbol, so a run is the same every time.

export const SYMBOLS = [
  { symbol: 'NOVA', name: 'Nova Robotics', price: 182.4, drift: 0.0004, vol: 0.012 },
  { symbol: 'KELP', name: 'Kelp Foods', price: 41.25, drift: -0.0002, vol: 0.009 },
  { symbol: 'ARCH', name: 'Archway Logistics', price: 96.1, drift: 0.0001, vol: 0.007 },
  { symbol: 'VOLT', name: 'Volt Grid', price: 23.8, drift: 0.0006, vol: 0.018 },
  { symbol: 'MESA', name: 'Mesa Health', price: 310.5, drift: 0.0002, vol: 0.006 },
  { symbol: 'ORBT', name: 'Orbital Data', price: 67.35, drift: -0.0001, vol: 0.014 },
];

/** A small, fast seeded generator (mulberry32). */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const HISTORY = 60;
const round = (value) => Math.round(value * 100) / 100;

/** The starting quotes: each symbol with a little history already. */
export function initialQuotes(next) {
  return SYMBOLS.map((info) => {
    const points = [info.price];
    for (let i = 1; i < 30; i++) points.unshift(step(points[0], info, next, -1));
    return { ...info, open: points[0], price: points[points.length - 1], points };
  });
}

/** One move of a price (direction -1 walks backwards, for history). */
export function step(price, info, next, direction = 1) {
  const shock = (next() + next() + next() - 1.5) * 2 * info.vol; // roughly normal
  return Math.max(0.5, round(price * (1 + direction * info.drift + shock)));
}

export const money = (value) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
