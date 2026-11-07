// For the tests: back to the seed data.
import { reset } from '#lib/server/log.js';

export function POST() {
  reset();
  return new Response(null, { status: 204 });
}
