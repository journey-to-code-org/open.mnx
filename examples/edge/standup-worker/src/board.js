// The board's Durable Object: @zubra/sync's server (its log in this object's SQLite), and the one
// decision that mustn't be made twice at once. Everything else (cards, presence) is the devices'.
import { SyncObject } from '@zubra/sync/durable';

export class Board extends SyncObject {
  /**
   * Who leads today's standup: the first to ask. The object runs one call at a time, so two people
   * pressing "Lead today" together can't both read "nobody" before either writes.
   */
  async lead(name) {
    const today = (await this.documents()).get('meta', 'today');
    if (today?.lead) return today.lead === name ? { ok: true, lead: name } : { error: `${today.lead} is leading today` };
    await this.write('meta', 'today', { lead: name });
    return { ok: true, lead: name };
  }
}
