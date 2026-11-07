// POST /reset puts the sign-ups back (for the tests).
import { resetPotluck } from '../lib/potluck.js';

export function POST() {
  resetPotluck();
  return new Response(null, { status: 204 });
}
