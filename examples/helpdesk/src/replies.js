// Adding a reply to a ticket: the rules, whoever calls them. The reply box's 'use server'
// function calls this with the signed-in user and the store (`@zubra/actions`' context).
export async function addReply({ store, user, now }, formData) {
  if (!user) return { error: 'Sign in to reply' };
  const id = Number(formData.get('ticket'));
  const ticket = await store.getTicket(id);
  // The ticket id comes from the form, so it's checked like any other input.
  if (!ticket || (user.role !== 'agent' && ticket.requester !== user.id)) return { error: 'No such ticket' };
  const body = String(formData.get('body') ?? '').trim();
  if (!body) return { id };
  const agent = user.role === 'agent';
  const internal = agent && formData.get('internal') === 'on';
  const at = now();
  // A public reply from the support side waits on the customer; one from the customer reopens.
  const status = internal ? ticket.status : agent ? 'pending' : 'open';
  await store.addMessage(id, { id: `m${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`, author: user.id, body: body.slice(0, 4000), at, internal }, { status });
  return { id };
}
