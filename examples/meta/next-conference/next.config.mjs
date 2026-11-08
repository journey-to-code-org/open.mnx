// Turbopack takes webpack-style loaders: zubra's turns each `.zb` import into the element and,
// as the default export, a React (client) component. In the server's build it also registers
// how to render the component, so the React wrapper puts each shadow-DOM component's
// declarative shadow root into the server's HTML: the cards show before JavaScript.
const loader = '@zubra/unplugin/loader';

export default {
  // The server renders with @zubra/compiler at request time, from node_modules.
  serverExternalPackages: ['@zubra/compiler'],
  turbopack: {
    rules: {
      '*.zb': [
        { condition: 'browser', loaders: [loader], as: '*.js' },
        { condition: { not: 'browser' }, loaders: [{ loader, options: { server: true } }], as: '*.js' },
      ],
    },
  },
};
