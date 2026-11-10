// @zubra/server in a Worker, used as a Node program would: createZubra over a components folder.
import { createZubra } from '@zubra/server';

export default {
  async fetch() {
    const zubra = createZubra({ components: 'components' });
    return new Response(zubra.render('price-tag', { cents: 129900 }));
  },
};
