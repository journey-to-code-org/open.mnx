export default defineEventHandler((event) => {
  const book = findBook(getRouterParam(event, 'id') ?? '');
  if (!book) throw createError({ statusCode: 404, statusMessage: 'No such book' });
  return book;
});
