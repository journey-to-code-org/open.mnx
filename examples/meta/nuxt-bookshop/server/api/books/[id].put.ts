// Saves a book's price, stock, tags and featured flag, validated like a form would be.
export default defineEventHandler(async (event) => {
  const book = findBook(getRouterParam(event, 'id') ?? '');
  if (!book) throw createError({ statusCode: 404, statusMessage: 'No such book' });
  const body = await readBody(event);
  const errors: Record<string, string> = {};
  if (body.price !== null && !(typeof body.price === 'number' && body.price > 0 && body.price < 1000)) errors.price = 'A price between 0 and 1,000.';
  if (!(Number.isInteger(body.stock) && body.stock >= 0 && body.stock <= 999)) errors.stock = 'Stock is a whole number from 0 to 999.';
  if (!(Array.isArray(body.tags) && body.tags.length <= 6 && body.tags.every((tag: unknown) => typeof tag === 'string'))) errors.tags = 'Up to six tags.';
  if (Object.keys(errors).length) throw createError({ statusCode: 422, statusMessage: 'Invalid', data: errors });
  Object.assign(book, { price: body.price, stock: body.stock, tags: body.tags, featured: Boolean(body.featured) });
  return book;
});
