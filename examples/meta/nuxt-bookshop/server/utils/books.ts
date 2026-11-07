// The inventory, in the server's memory (seeded on start; a real shop would use a database).
export interface Book {
  id: string;
  title: string;
  author: string;
  genre: 'fiction' | 'nonfiction' | 'kids';
  price: number | null;
  stock: number;
  reorder: number;
  tags: string[];
  featured: boolean;
}

const seed = (): Book[] => [
  { id: 'b1', title: 'The Quiet Orchard', author: 'Mara Lind', genre: 'fiction', price: 18.5, stock: 12, reorder: 3, tags: ['literary', 'debut'], featured: true },
  { id: 'b2', title: 'Rivers of Salt', author: 'Tomas Ek', genre: 'fiction', price: 21, stock: 2, reorder: 4, tags: ['historical'], featured: false },
  { id: 'b3', title: 'How Bridges Stand', author: 'Ines Duarte', genre: 'nonfiction', price: 28, stock: 7, reorder: 2, tags: ['engineering', 'illustrated'], featured: false },
  { id: 'b4', title: 'The Small Brave Fox', author: 'Kit Moreau', genre: 'kids', price: 12.99, stock: 0, reorder: 5, tags: ['picture-book'], featured: true },
  { id: 'b5', title: 'Notes on Bread', author: 'Hanne Aas', genre: 'nonfiction', price: 24, stock: 15, reorder: 3, tags: ['food'], featured: false },
  { id: 'b6', title: 'Night Train North', author: 'Mara Lind', genre: 'fiction', price: 19.75, stock: 5, reorder: 3, tags: ['mystery'], featured: false },
  { id: 'b7', title: 'Counting Stars', author: 'Ola Bright', genre: 'kids', price: 9.5, stock: 3, reorder: 4, tags: ['picture-book', 'bedtime'], featured: false },
];

const state = globalThis as unknown as { __books?: Book[] };
export const books = (): Book[] => (state.__books ??= seed());
export const resetBooks = () => { state.__books = seed(); };
export const findBook = (id: string) => books().find((book) => book.id === id);
