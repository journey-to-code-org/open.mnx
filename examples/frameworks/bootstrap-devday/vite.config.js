import zubra from '@zubra/unplugin/vite';

export default {
  plugins: [zubra()],
  css: {
    preprocessorOptions: {
      // Bootstrap 5's Sass still uses @import and global functions, which Dart Sass warns about.
      scss: { quietDeps: true, silenceDeprecations: ['import', 'global-builtin', 'color-functions', 'if-function'] },
    },
  },
};
