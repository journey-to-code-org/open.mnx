import { reset } from '../lib/trip.server.js';

export function action() {
  reset();
  return new Response(null, { status: 204 });
}
