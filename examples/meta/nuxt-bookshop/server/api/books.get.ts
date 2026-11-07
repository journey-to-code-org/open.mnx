export default defineEventHandler((event) => {
  const { genre, q } = getQuery(event);
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  return books()
    .filter((book) => !genre || genre === 'all' || book.genre === genre)
    .filter((book) => !needle || `${book.title} ${book.author} ${book.tags.join(' ')}`.toLowerCase().includes(needle));
});
