// Runs every case of @zubra/sync's log contract against durableObjectLog in a real Durable Object,
// one fresh object per case, in both modes (every change, and each field's latest value), and
// answers with what passed and what failed.
import { DurableObject } from 'cloudflare:workers';
import { durableObjectLog } from '@zubra/sync/durable';
import { logContract, latestContract } from '../../../../../sync/test/log-contract.js';

const cases = [
  ...logContract.map((contract) => ({ contract, options: {} })),
  ...[...logContract, ...latestContract].map((contract) => ({ contract, options: { keep: 'latest' } })),
];

export class Logs extends DurableObject {
  async run(index) {
    const { contract, options } = cases[index];
    const name = `${options.keep ?? 'all'}: ${contract.name}`;
    try {
      await contract.run(durableObjectLog(this.ctx.storage, options));
      return { name, ok: true };
    } catch (error) {
      return { name, ok: false, error: String(error?.stack ?? error) };
    }
  }
}

export default {
  async fetch(request, env) {
    const results = [];
    for (const [index] of cases.entries()) {
      results.push(await env.LOGS.get(env.LOGS.newUniqueId()).run(index));
    }
    return Response.json(results);
  },
};
