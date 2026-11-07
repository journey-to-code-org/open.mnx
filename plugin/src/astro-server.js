// The Astro renderer's server side: renders an mnx element with @mnx/runtime/server.
import { canRender, renderToString } from '@mnx/runtime/server';

// Astro passes named slots camelCased (`slot="side-note"` → `sideNote`).
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function slotName(meta, name) {
  if (name === 'default' || meta.slots.includes(name)) return name;
  if (meta.slots.includes(kebab(name))) return kebab(name);
  throw new Error(`mnx: <${meta.tag}> has no slot \`${name}\``);
}

export default {
  name: '@mnx/astro',
  check(Component) {
    return canRender(Component);
  },
  async renderToStaticMarkup(Component, given, slotted) {
    const meta = Component.mnx;
    const props = {};
    const attributes = {};
    for (const [name, value] of Object.entries(given ?? {})) {
      if (value === undefined || typeof value === 'function') continue;
      if (Object.hasOwn(meta.props, name)) props[name] = value;
      else attributes[name] = value;
    }
    const slots = {};
    for (const [name, html] of Object.entries(slotted ?? {})) {
      const content = String(html ?? '');
      if (content.trim()) slots[slotName(meta, name)] = content;
    }
    return { html: renderToString(Component, { props, attributes, slots }) };
  },
  supportsAstroStaticSlot: false,
};
