import tailwindcss from '@tailwindcss/vite';
import zubra from '@zubra/unplugin/vite';

// Tailwind 4 scans the project for class names, .zb files included.
export default { plugins: [zubra(), tailwindcss()] };
