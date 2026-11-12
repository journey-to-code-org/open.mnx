import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import zubra from '@zubra/unplugin/vite';

export default defineConfig({
  plugins: [zubra()],
  test: {
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
