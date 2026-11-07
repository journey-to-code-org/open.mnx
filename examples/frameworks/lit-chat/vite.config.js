import mnx from '@mnx/unplugin/vite';

// Lit needs no plugin; mnx elements are used in its templates with .prop and @event bindings.
export default { plugins: [mnx()] };
