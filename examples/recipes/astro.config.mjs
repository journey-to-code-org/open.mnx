import zubra from '@zubra/unplugin/astro';

// DEMO_BASE: the path the site is served under (the demo gallery's /<repo>/demos/recipes/).
export default { base: process.env.DEMO_BASE ?? '/', integrations: [zubra()] };
