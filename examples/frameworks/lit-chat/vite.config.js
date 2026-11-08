import zubra from '@zubra/unplugin/vite';

// Lit needs no plugin; zubra elements are used in its templates with .prop and @event bindings.
export default { plugins: [zubra()] };
