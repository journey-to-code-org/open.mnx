# Zubra brand

The mark is a Z of three stripes that meet edge to edge: two ink bars and an accent diagonal.

| File | Use |
|---|---|
| `zubra-mark.svg` | The mark on light backgrounds (ink `#14161F`, accent `#4f5df5`). |
| `zubra-mark-on-dark.svg` | The mark on dark backgrounds (`#F2F3F8`, `#8b95ff`). |
| `zubra-tile.svg` | The mark as a white Z on an indigo tile, for places that need a square icon with its own background: favicons, avatars, the README. Works on light and dark. |
| `zubra-tile-512.png` | The tile as a 512 px PNG, for avatars that don't take SVG (GitHub, npm). |

- The landing page and the docs site's header (both through `site/src/_includes/mark.njk`), `site/src/favicon.svg` and `site/src/apple-touch-icon.png` draw the same shapes. `demos/test/landing.test.js` fails if they drift from these files.
- Keep clear space around the mark of at least a quarter of its height, and don't go below 16 px (the tile holds up there; the bare mark is better from 24 px).
- Colour: ink `#14161F`, indigo `#4f5df5` (`#8b95ff` on dark), surface `#F4F5FA`. The type on the site is the system font stack; there is no wordmark file yet.
- Don't recolour the diagonal, stretch the mark, or put the bare mark on a busy background: use the tile there.
