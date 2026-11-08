import preact from '@preact/preset-vite';
import zubra from '@zubra/unplugin/vite';

export default { plugins: [zubra(), preact()] };
