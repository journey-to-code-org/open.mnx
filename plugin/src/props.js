// `mnx-props` for Svelte and Solid. React's and Vue's adapters write it themselves; Svelte and Solid
// use the elements directly, and their server HTML has no object props (Svelte writes
// "[object Object]", Solid's `prop:` values are properties). So in their server builds, each mnx
// host in a component's markup gets `mnx-props={JSON.stringify({ … })}` from the attributes that
// set its props, and `@mnx/server`'s injectShadowRoots() renders it complete.

/**
 * `code` with `mnx-props` added to the hosts of `tags` (tag → its prop names). `dialect` is
 * `svelte` (`log={…}`, `{log}`, `bind:value={…}`) or `solid` (`prop:items={…}`, `items={…}`).
 */
export function addProps(code, tags, dialect) {
  if (!tags.size) return null;
  const names = [...tags.keys()].map((tag) => tag.replace(/[-]/g, '\\-')).join('|');
  const opening = new RegExp(`<(${names})(?=[\\s/>])`, 'g');
  const edits = [];
  for (let match; (match = opening.exec(code)); ) {
    const props = tags.get(match[1]);
    const attributes = readAttributes(code, match.index + match[0].length);
    if (!attributes) continue;
    opening.lastIndex = attributes.end;
    if (attributes.list.some((attribute) => attribute.name === 'mnx-props')) continue;
    const entries = [];
    for (const { name, expression, shorthand } of attributes.list) {
      if (expression == null) continue;
      const prop = dialect === 'solid' ? name.replace(/^prop:/, '') : name.replace(/^bind:/, '');
      if (!props.has(prop)) continue;
      if (shorthand) entries.push(prop);
      else entries.push(`${JSON.stringify(prop)}: (${expression})`);
    }
    if (!entries.length) continue;
    edits.push({ at: match.index + match[0].length, text: ` mnx-props={JSON.stringify({ ${entries.join(', ')} })}` });
  }
  if (!edits.length) return null;
  let out = code;
  for (const { at, text } of edits.reverse()) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

/** The attributes of a tag whose name ends at `start`, up to its `>`: `{ list, end }`, or null. */
export function readAttributes(code, start) {
  const list = [];
  let i = start;
  while (i < code.length) {
    while (/\s/.test(code[i])) i++;
    if (code[i] === '>') return { list, end: i + 1 };
    if (code[i] === '/' && code[i + 1] === '>') return { list, end: i + 2 };
    if (code[i] === '{') {
      // Svelte's shorthand (`{log}`) or a spread (`{...rest}`).
      const end = closeBrace(code, i);
      if (end < 0) return null;
      const inner = code.slice(i + 1, end).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(inner)) list.push({ name: inner, expression: inner, shorthand: true });
      i = end + 1;
      continue;
    }
    const name = /^[^\s=/>{"']+/.exec(code.slice(i))?.[0];
    if (!name) return null;
    i += name.length;
    while (/\s/.test(code[i])) i++;
    if (code[i] !== '=') {
      list.push({ name, expression: null });
      continue;
    }
    i++;
    while (/\s/.test(code[i])) i++;
    if (code[i] === '"' || code[i] === "'") {
      const end = code.indexOf(code[i], i + 1);
      if (end < 0) return null;
      list.push({ name, expression: null, text: code.slice(i + 1, end) });
      i = end + 1;
    } else if (code[i] === '{') {
      const end = closeBrace(code, i);
      if (end < 0) return null;
      list.push({ name, expression: code.slice(i + 1, end).trim() });
      i = end + 1;
    } else {
      const value = /^[^\s>]+/.exec(code.slice(i))?.[0] ?? '';
      list.push({ name, expression: null, text: value });
      i += value.length;
    }
  }
  return null;
}

/** The index of the `}` closing the `{` at `start` (strings and template literals skipped), or -1. */
function closeBrace(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      i = skipString(code, i);
      if (i < 0) return -1;
    } else if (c === '`') {
      i = skipTemplate(code, i);
      if (i < 0) return -1;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

function skipString(code, start) {
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === code[start]) return i;
  }
  return -1;
}

function skipTemplate(code, start) {
  for (let i = start + 1; i < code.length; i++) {
    if (code[i] === '\\') i++;
    else if (code[i] === '`') return i;
    else if (code[i] === '$' && code[i + 1] === '{') {
      i = closeBrace(code, i + 1);
      if (i < 0) return -1;
    }
  }
  return -1;
}

/** The `.mnx` files a module imports (specifiers, as written). */
export function mnxImports(code) {
  const found = [];
  const pattern = /\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+\.mnx(?:\.[jt]sx)?)(?:\?[^'"]*)?['"]/g;
  for (let match; (match = pattern.exec(code)); ) found.push(match[1]);
  return found;
}
