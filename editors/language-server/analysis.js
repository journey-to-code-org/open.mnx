// What the language server knows about a `.mnx` document, as plain functions (no LSP types
// beyond positions), so they can be tested directly.

/** The directives, with their attributes. */
export const DIRECTIVES = {
  'mnx-if': { description: 'Render the content when `test` is truthy; an optional final `<mnx-else>` otherwise.', attributes: { test: 'The condition: `test={…}`.' } },
  'mnx-else': { description: 'The content of an `<mnx-if>` when its test is falsy. Must be its last child.', attributes: {} },
  'mnx-each': {
    description: 'Render the content once per item of `items`.',
    attributes: { items: 'The array: `items={…}`.', as: 'The name of each item.', index: 'The name of the index (optional).', key: 'A unique string or number per item, so rows follow their items: `key={item.id}`.' },
  },
  'mnx-slot': { description: 'Where content given to the element goes; the children are the fallback.', attributes: { name: 'The slot name (omit for the default slot).' } },
  'mnx-await': { description: 'Show the content while `value` (a promise or a `resource()`) is pending, then `<mnx-then>` or `<mnx-catch>`.', attributes: { value: 'The promise or resource: `value={…}`.' } },
  'mnx-then': { description: 'The content of an `<mnx-await>` once its value has resolved.', attributes: { as: 'The name of the resolved value.' } },
  'mnx-catch': { description: 'The content of an `<mnx-await>` if its value rejected.', attributes: { as: 'The name of the error.' } },
};

/** Line/character → offset. */
export function offsetAt(text, { line, character }) {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + character, text.length);
}

export function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, character: offset - (before.lastIndexOf('\n') + 1) };
}

/** Where the cursor is: in the script or style, in a tag name, in a start tag's attributes, or in the template. */
export function contextAt(text, offset) {
  const before = text.slice(0, offset);
  const lower = before.toLowerCase();
  for (const block of ['script', 'style']) {
    const open = lower.lastIndexOf(`<${block}`);
    if (open >= 0 && lower.indexOf(`</${block}`, open) < 0) return { kind: block };
  }
  const lt = before.lastIndexOf('<');
  const gt = before.lastIndexOf('>');
  const brace = before.lastIndexOf('{');
  const closeBrace = before.lastIndexOf('}');
  if (brace > closeBrace && brace > gt) return { kind: 'expression' };
  if (lt > gt) {
    const inside = before.slice(lt + 1);
    const tag = inside.match(/^\/?[a-zA-Z][\w.-]*/)?.[0] ?? '';
    if (inside === tag && !tag.startsWith('/')) return { kind: 'tag', prefix: tag };
    if (!tag.startsWith('/') && /\s/.test(inside.slice(tag.length, tag.length + 1))) {
      const attribute = inside.match(/([\w:-]*)$/)?.[1] ?? '';
      // Inside a quoted value?
      const quotes = (inside.match(/"/g)?.length ?? 0) % 2;
      if (!quotes) return { kind: 'attribute', tag, prefix: attribute };
    }
  }
  return { kind: 'template' };
}

/** The host tag and its props, read from the source (for completions in expressions). */
export function hostOf(text) {
  const withoutBlocks = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, (block) => ' '.repeat(block.length)).replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));
  const match = withoutBlocks.match(/<([a-z][\w.]*-[\w.-]*)([^>]*)>/);
  if (!match) return null;
  const props = attributeNames(match[2]).filter((name) => !['shadow', 'form-associated'].includes(name));
  return { tag: match[1], offset: match.index, props: props.map((name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())) };
}

/** Attribute names in a start tag's attribute text, skipping quoted and `{…}` values. */
export function attributeNames(text) {
  const names = [];
  let i = 0;
  while (i < text.length) {
    const character = text[i];
    if (character === '"' || character === "'") {
      const end = text.indexOf(character, i + 1);
      i = end < 0 ? text.length : end + 1;
    } else if (character === '{') {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) break;
      }
      i++;
    } else if (/[a-zA-Z]/.test(character)) {
      const name = text.slice(i).match(/^[a-zA-Z][\w:-]*/)[0];
      names.push(name);
      i += name.length;
    } else {
      i++;
    }
  }
  return names;
}

/** A component's interface from its Custom Elements Manifest. */
export function interfaceOf(manifest) {
  const element = manifest?.modules?.[0]?.declarations?.find((declaration) => declaration.customElement);
  if (!element) return null;
  return {
    tag: element.tagName,
    description: element.description ?? '',
    attributes: (element.attributes ?? []).map((attribute) => ({ name: attribute.name, type: attribute.type?.text ?? 'unknown', default: attribute.default })),
    events: (element.events ?? []).map((event) => ({ name: event.name, type: event.type?.text ?? 'CustomEvent', description: event.description ?? '' })),
    slots: (element.slots ?? []).map((slot) => slot.name),
  };
}

/** Markdown documentation for a component. */
export function documentation(component) {
  const lines = [`**<${component.tag}>**`];
  if (component.description) lines.push('', component.description);
  if (component.attributes.length) {
    lines.push('', '| Prop | Type | Default |', '|---|---|---|');
    for (const attribute of component.attributes) lines.push(`| \`${attribute.name}\` | \`${attribute.type}\` | ${attribute.default === undefined ? 'required' : `\`${attribute.default}\``} |`);
  }
  if (component.events.length) {
    lines.push('', 'Events: ' + component.events.map((event) => `\`${event.name}\` (\`${event.type}\`)`).join(', '));
  }
  if (component.slots.length) lines.push('', 'Slots: ' + component.slots.map((name) => (name ? `\`${name}\`` : 'default')).join(', '));
  return lines.join('\n');
}

/** Completion items (label, kind, detail, documentation, insertText) at `offset`. */
export function completions(text, offset, components) {
  const context = contextAt(text, offset);
  if (context.kind === 'tag') {
    return [
      ...Object.entries(DIRECTIVES).map(([name, directive]) => ({ label: name, kind: 'directive', documentation: directive.description })),
      ...components.map((component) => ({ label: component.tag, kind: 'component', documentation: documentation(component) })),
    ].filter((item) => item.label.startsWith(context.prefix));
  }
  if (context.kind === 'attribute') {
    const directive = DIRECTIVES[context.tag];
    if (directive) {
      return Object.entries(directive.attributes).map(([name, description]) => ({
        label: name, kind: 'attribute', documentation: description, insertText: ['as', 'index', 'name'].includes(name) ? `${name}="$1"` : `${name}={$1}`, snippet: true,
      }));
    }
    const component = components.find((candidate) => candidate.tag === context.tag);
    if (!component) return [];
    return [
      ...component.attributes.map((attribute) => ({
        label: attribute.name, kind: 'attribute', detail: attribute.type,
        documentation: attribute.default === undefined ? 'Required.' : `Default: \`${attribute.default}\`.`,
        insertText: `${attribute.name}={$1}`, snippet: true,
      })),
      ...component.events.map((event) => ({
        label: `on${event.name}`, kind: 'event', detail: event.type, documentation: event.description,
        insertText: `on${event.name}={$1}`, snippet: true,
      })),
    ].filter((item) => item.label.startsWith(context.prefix));
  }
  if (context.kind === 'expression') {
    return (hostOf(text)?.props ?? []).map((name) => ({ label: name, kind: 'variable', detail: 'prop' }));
  }
  return [];
}

/** The tag name under `offset`, with its range. */
export function tagAt(text, offset) {
  const start = text.lastIndexOf('<', offset);
  if (start < 0) return null;
  const match = text.slice(start).match(/^<\/?([a-zA-Z][\w.-]*)/);
  if (!match) return null;
  const nameStart = start + match[0].length - match[1].length;
  const nameEnd = nameStart + match[1].length;
  if (offset < nameStart || offset > nameEnd) return null;
  return { name: match[1], start: nameStart, end: nameEnd };
}
