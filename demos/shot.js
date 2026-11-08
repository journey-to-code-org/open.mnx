// The screenshot an example's own browser test takes for the demo gallery (demos/shots/), when
// ZUBRA_SHOTS names the folder: `ZUBRA_SHOTS=$PWD/demos/shots npm test` in the example's folder.
// Otherwise it does nothing. 1280×800, JPEG at quality 80, like demos/screenshots.mjs.
import { join } from 'node:path';

// `resize: false` keeps a window's own size (an Electron window, an extension's popup).
export async function shot(page, id, { resize = true } = {}) {
  const dir = process.env.ZUBRA_SHOTS;
  if (!dir) return;
  if (resize) await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${id}.jpg`), type: 'jpeg', quality: 80 });
}
