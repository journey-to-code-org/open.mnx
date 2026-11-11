// Runs every case of @zubra/sync's log contract against durableObjectLog in a real Durable Object,
// one fresh object per case, and answers with what passed and what failed.
import { DurableObject } from 'cloudflare:workers';
import { durableObjectLog } from '@zubra/sync/durable';
import { logContract } from '../../../../../sync/test/log-contract.js';

export class Logs extends DurableObject {
  async run(index) {
    const contract = logContract[index];
    try {
      await contract.run(durableObjectLog(this.ctx.storage));
      return { name: contract.name, ok: true };
    } catch (error) {
      return { name: contract.name, ok: false, error: String(error?.stack ?? error) };
    }
  }
}

export default {
  async fetch(request, env) {
    const results = [];
    for (const [index] of logContract.entries()) {
      results.push(await env.LOGS.get(env.LOGS.newUniqueId()).run(index));
    }
    return Response.json(results);
  },
};
