// Turbopack takes webpack-style loaders: mnx's turns each `.mnx` import into the element and,
// as the default export, a React (client) component.
export default {
  turbopack: {
    rules: {
      '*.mnx': { loaders: ['@mnx/unplugin/loader'], as: '*.js' },
    },
  },
};
