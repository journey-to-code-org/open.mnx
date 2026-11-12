// An MCP server for a component library: coding agents ask it which components there are, what
// each takes (props, events with their detail types, slots) and how to use one from a framework,
// and have markup they wrote checked against the real API. Built from the Custom Elements
// Manifest, so it describes any Zubra library (and any other library that ships a manifest).
//
//   npx zubra mcp                          # the components under ./src/components, or ./custom-elements.json
//   npx zubra mcp @acme/ui                 # an installed package's manifest (package.json "customElements")
//   npx zubra mcp dist/custom-elements.json src/components
//
//   // .mcp.json (Claude Code, and other clients that read it)
//   { "mcpServers": { "components": { "command": "npx", "args": ["zubra", "mcp", "@acme/ui"] } } }
//
// It speaks MCP over standard input and output (JSON-RPC, a message per line) and needs no
// network, no model and no account: it only reads the manifest.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { compileFile } from './index.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const SOURCE = /\.zb(?:\.[jt]sx)?$/;
const FRAMEWORKS = ['html', 'react', 'vue', 'svelte', 'solid', 'angular'];
// Attributes every element takes, which a check shouldn't report.
const GLOBAL = /^(id|class|classname|style|slot|title|lang|dir|hidden|tabindex|role|part|key|ref|name|form|disabled|aria-[\w-]+|data-[\w-]+|zb-props|v-[\w:.-]+|bind:[\w-]+|use:[\w-]+|client:[\w-]+|#[\w-]+)$/i;

const parseDefault = (text) => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Components from a manifest object: one entry per custom element declaration. */
export function fromManifest(manifest, origin = '') {
  const components = [];
  for (const module of manifest.modules ?? []) {
    for (const declaration of module.declarations ?? []) {
      if (!declaration.customElement || !declaration.tagName) continue;
      const fields = new Map((declaration.members ?? []).filter((m) => m.kind === 'field').map((m) => [m.name, m]));
      const props = (declaration.attributes ?? []).map((attribute) => {
        const field = fields.get(attribute.fieldName ?? attribute.name);
        return {
          name: attribute.fieldName ?? attribute.name,
          attribute: attribute.name,
          type: attribute.type?.text ?? field?.type?.text ?? 'unknown',
          default: parseDefault(attribute.default ?? field?.default),
          ...(attribute.description ? { description: attribute.description } : {}),
        };
      });
      // Fields with no attribute are props too (set as properties).
      for (const [name, field] of fields) {
        if (!props.some((prop) => prop.name === name)) props.push({ name, attribute: null, type: field.type?.text ?? 'unknown', default: parseDefault(field.default) });
      }
      const events = (declaration.events ?? []).map((event) => ({
        name: event.name,
        detail: event.type?.text?.match(/^CustomEvent<(.*)>$/s)?.[1] ?? null,
        ...(event.description ? { description: event.description } : {}),
      }));
      const description = (declaration.description ?? '').split('\n').filter((line) => !line.startsWith('@')).join('\n').trim();
      components.push({
        tag: declaration.tagName,
        name: declaration.name,
        description,
        props,
        events,
        slots: (declaration.slots ?? []).map((slot) => slot.name || 'default'),
        models: props.filter((prop) => events.some((event) => event.name === `${prop.name.toLowerCase()}change`)).map((prop) => prop.name),
        module: module.path,
        origin,
      });
    }
  }
  return components;
}

const walk = (dir) => readdirSync(dir).sort().flatMap((entry) => {
  const path = join(dir, entry);
  if (statSync(path).isDirectory()) return entry === 'node_modules' || entry.startsWith('.') ? [] : walk(path);
  return SOURCE.test(entry) ? [path] : [];
});

/**
 * Load components from each source: a `custom-elements.json`, a folder (its manifest if it has
 * one, otherwise its `.zb` components, compiled), or an installed package's name.
 */
export function loadComponents(sources, { cwd = process.cwd() } = {}) {
  if (!sources.length) {
    sources = existsSync(join(cwd, 'custom-elements.json')) ? ['custom-elements.json'] : existsSync(join(cwd, 'src/components')) ? ['src/components'] : [];
    if (!sources.length) throw new Error('zubra mcp: say where the components are: a custom-elements.json, a components folder, or a package name');
  }
  const components = [];
  for (const source of sources) {
    const path = resolve(cwd, source);
    if (existsSync(path) && statSync(path).isFile()) {
      components.push(...fromManifest(JSON.parse(readFileSync(path, 'utf8')), source));
    } else if (existsSync(path) && existsSync(join(path, 'custom-elements.json'))) {
      components.push(...fromManifest(JSON.parse(readFileSync(join(path, 'custom-elements.json'), 'utf8')), source));
    } else if (existsSync(path)) {
      const files = walk(path);
      if (!files.length) throw new Error(`zubra mcp: no components (.zb, .zb.jsx, .zb.tsx) or custom-elements.json in ${source}`);
      for (const file of files) {
        const response = compileFile(file, { emit: 'manifest', modulePath: file.slice(path.length + 1).replace(SOURCE, '.js') });
        if (!response.ok) throw new Error(response.error);
        components.push(...fromManifest(JSON.parse(response.output), source));
      }
    } else {
      let pkg;
      try {
        pkg = createRequire(join(cwd, 'package.json')).resolve(`${source}/package.json`);
      } catch {
        throw new Error(`zubra mcp: ${source} is not a file, a folder or an installed package`);
      }
      const manifest = JSON.parse(readFileSync(pkg, 'utf8')).customElements ?? 'custom-elements.json';
      const file = join(dirname(pkg), manifest);
      if (!existsSync(file)) throw new Error(`zubra mcp: ${source} has no Custom Elements Manifest (package.json "customElements")`);
      components.push(...fromManifest(JSON.parse(readFileSync(file, 'utf8')), source));
    }
  }
  return components;
}

const pascal = (tag) => tag.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const reactEvent = (name, props) => {
  // The adapter takes any casing; name the model events after their prop (onValueChange).
  const model = props.find((prop) => `${prop.name.toLowerCase()}change` === name);
  return model ? `on${model.name[0].toUpperCase()}${model.name.slice(1)}Change` : `on${name[0].toUpperCase()}${name.slice(1)}`;
};
const example = (prop) => {
  if (prop.default !== undefined && prop.default !== null && prop.default !== '') return prop.default;
  if (/number/.test(prop.type)) return 1;
  if (/boolean/.test(prop.type)) return true;
  if (/\[\]|Array/.test(prop.type)) return [];
  if (/^string|"/.test(prop.type)) return 'text';
  return {};
};

/** How to use `component` from `framework`: an import (where there is one) and the markup. */
export function usage(component, framework = 'html', from = component.origin) {
  if (!FRAMEWORKS.includes(framework)) throw new Error(`framework must be one of ${FRAMEWORKS.join(', ')}`);
  const { tag, props, events, slots, models } = component;
  const Name = component.name ?? pascal(tag);
  const model = models[0];
  // A flag that's off by default is opt-in: leave it out of the example.
  const shown = props.filter((prop) => !(prop.default === false && prop.name !== model)).slice(0, 6);
  const event = events.find((e) => !model || e.name !== `${model.toLowerCase()}change`) ?? null;
  const named = slots.filter((slot) => slot !== 'default');
  // An installed package's name, not a path: imports come from it.
  const pkg = from && /^(@[\w.-]+\/)?[\w.-]+$/.test(from) && !from.endsWith('.json') && !existsSync(resolve(from)) ? from : null;
  const lines = [];
  const value = (prop) => JSON.stringify(example(prop));
  if (framework === 'react') {
    if (pkg) lines.push(`import ${Name} from '${pkg}/react/${component.module.replace(/\.js$/, '')}';`);
    else lines.push(`import ${Name} from './${component.module.replace(/\.js$/, '.zb')}';   // the build plugin makes it a React component`);
    const attrs = shown.filter((prop) => prop.name !== model).map((prop) => ` ${prop.name}={${value(prop)}}`);
    if (model) attrs.unshift(` ${model}={${camel(model)}} ${reactEvent(`${model.toLowerCase()}change`, props)}={(event) => set${model[0].toUpperCase()}${model.slice(1)}(event.detail)}`);
    if (event) attrs.push(` ${reactEvent(event.name, props)}={(event) => console.log(event.detail)}`);
    lines.push(`<${Name}${attrs.join('')}>${named.map((slot) => `\n  <span slot="${slot}">…</span>`).join('')}${slots.includes('default') ? '\n  …' : ''}${named.length || slots.includes('default') ? '\n' : ''}</${Name}>`);
  } else if (framework === 'vue') {
    if (pkg) lines.push(`import ${Name} from '${pkg}/vue/${component.module.replace(/\.js$/, '')}';`);
    else lines.push(`import ${Name} from './${component.module.replace(/\.js$/, '.zb')}';   // the build plugin makes it a Vue component`);
    const attrs = shown.filter((prop) => prop.name !== model).map((prop) => (typeof example(prop) === 'string' ? ` ${prop.attribute ?? prop.name}=${JSON.stringify(example(prop))}` : ` :${prop.name}='${JSON.stringify(example(prop))}'`));
    if (model) attrs.unshift(model === 'value' ? ` v-model="${camel(model)}"` : ` v-model:${model}="${camel(model)}"`);
    if (event) attrs.push(` @${event.name}="(event) => console.log(event.detail)"`);
    lines.push(`<${Name}${attrs.join('')}>${named.map((slot) => `\n  <template #${slot}>…</template>`).join('')}${slots.includes('default') ? '\n  …' : ''}${named.length || slots.includes('default') ? '\n' : ''}</${Name}>`);
  } else {
    if (pkg) lines.push(`import '${pkg}/${component.module.replace(/\.js$/, '')}';   // defines <${tag}>`);
    const attrs = shown.filter((prop) => prop.name !== model || framework !== 'html').map((prop) => {
      const v = example(prop);
      if (framework === 'html') return typeof v === 'boolean' ? (v ? ` ${prop.attribute}` : '') : typeof v === 'object' ? ` ${prop.attribute ?? prop.name}='${JSON.stringify(v)}'` : ` ${prop.attribute ?? prop.name}="${String(v).replaceAll('"', '&quot;')}"`;
      if (framework === 'svelte') return prop.name === model ? ` ${prop.name}={${camel(prop.name)}} on${prop.name.toLowerCase()}change={(event) => (${camel(prop.name)} = event.detail)}` : ` ${prop.name}={${JSON.stringify(v)}}`;
      if (framework === 'solid') return prop.name === model ? ` prop:${prop.name}={${camel(prop.name)}()} on:${prop.name.toLowerCase()}change={(event) => set${prop.name[0].toUpperCase()}${prop.name.slice(1)}(event.detail)}` : typeof v === 'object' ? ` prop:${prop.name}={${JSON.stringify(v)}}` : ` ${prop.attribute ?? prop.name}={${JSON.stringify(v)}}`;
      return prop.name === model ? ` [${prop.name}]="${camel(prop.name)}" (${prop.name.toLowerCase()}change)="${camel(prop.name)} = $event.detail"` : ` [${prop.name}]='${JSON.stringify(v)}'`;
    });
    if (event) {
      if (framework === 'svelte') attrs.push(` on${event.name}={(event) => console.log(event.detail)}`);
      if (framework === 'solid') attrs.push(` on:${event.name}={(event) => console.log(event.detail)}`);
      if (framework === 'angular') attrs.push(` (${event.name})="handle($event.detail)"`);
    }
    lines.push(`<${tag}${attrs.join('')}>${named.map((slot) => `\n  <span slot="${slot}">…</span>`).join('')}${slots.includes('default') ? '\n  …' : ''}${named.length || slots.includes('default') ? '\n' : ''}</${tag}>`);
    if (framework === 'html' && (event || model)) {
      const listen = [model && `${model.toLowerCase()}change`, event?.name].filter(Boolean);
      lines.push(`<script type="module">\n  const el = document.querySelector('${tag}');\n${listen.map((name) => `  el.addEventListener('${name}', (event) => console.log(event.detail));`).join('\n')}\n</script>`);
    }
    if (framework === 'angular') lines.push(`// The component needs schemas: [CUSTOM_ELEMENTS_SCHEMA]; for forms, zubraModel from '@zubra/runtime/angular'.`);
  }
  return lines.join('\n');
}

/**
 * Check markup against the components' APIs: for each element of a known tag, attributes that
 * aren't props (or global attributes) and event listeners for events it doesn't fire, with the
 * nearest real name. Works on HTML, JSX, Vue and Svelte markup; it reads tags, not the language.
 */
export function check(components, markup) {
  const byTag = new Map(components.map((component) => [component.tag, component]));
  const byName = new Map(components.filter((c) => c.name).map((component) => [component.name, component]));
  const problems = [];
  for (const match of markup.matchAll(/<([A-Za-z][\w.-]*)(\s(?:[^>"'{]|"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\})*)?\/?>/g)) {
    const component = byTag.get(match[1]) ?? byName.get(match[1]);
    if (!component) continue;
    const attributes = [...(match[2] ?? '').matchAll(/(?:^|\s)([@:#.]?[A-Za-z_][\w:.@-]*)(?=\s*=|\s|$)/g)].map((m) => m[1]);
    for (const raw of attributes) {
      let name = raw.replace(/^[:.]|^prop:|^attr:|^\[|\]$/g, '').replace(/^v-bind:/, '');
      if (/^v-model(:|$)/.test(raw)) {
        const prop = raw.split(':')[1] ?? 'value';
        if (!component.models.includes(prop)) problems.push({ tag: component.tag, attribute: raw, problem: `no two-way prop "${prop}"`, suggestion: component.models[0] ? `v-model${component.models[0] === 'value' ? '' : `:${component.models[0]}`}` : null });
        continue;
      }
      let event = null;
      if (raw.startsWith('@') || raw.startsWith('on:')) event = raw.replace(/^@|^on:/, '').split('.')[0];
      else if (/^on[A-Za-z]/.test(name) && !component.props.some((prop) => prop.name === name)) event = name.slice(2);
      if (event !== null) {
        const lower = event.toLowerCase();
        if (component.events.some((e) => e.name === lower) || /^(click|input|change|focus|blur|focusin|focusout|key\w*|mouse\w*|pointer\w*|touch\w*|submit|scroll|wheel|drag\w*|drop|copy|cut|paste|contextmenu|dblclick)$/.test(lower)) continue;
        problems.push({ tag: component.tag, attribute: raw, problem: `<${component.tag}> doesn't fire "${lower}"`, suggestion: nearest(lower, component.events.map((e) => e.name)) });
        continue;
      }
      if (GLOBAL.test(name)) continue;
      if (component.props.some((prop) => prop.name === name || prop.attribute === name || prop.name.toLowerCase() === name.toLowerCase())) continue;
      problems.push({ tag: component.tag, attribute: raw, problem: `<${component.tag}> has no prop "${name}"`, suggestion: nearest(name, component.props.map((prop) => prop.name)) });
    }
  }
  return problems;
}

function nearest(word, candidates) {
  let best = null;
  let score = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(word.toLowerCase(), candidate.toLowerCase());
    if (distance < score) [best, score] = [candidate, distance];
  }
  return best !== null && score <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// ---- the MCP server --------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_components',
    title: 'List components',
    description: 'Every component in the library: its tag, class name and what it is for. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'describe_component',
    title: 'Describe a component',
    description: "One component's whole API: props (type, default, attribute), events (detail type), slots, and which props are two-way.",
    inputSchema: { type: 'object', properties: { tag: { type: 'string', description: 'The tag, like star-rating (or the class name)' } }, required: ['tag'], additionalProperties: false },
  },
  {
    name: 'component_usage',
    title: 'Show how to use a component',
    description: 'Markup (and the import) for using a component from a framework, with props, two-way binding, an event and slots in that framework\'s syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'The tag, like star-rating (or the class name)' },
        framework: { type: 'string', enum: FRAMEWORKS, description: 'Where it is used (default html)' },
      },
      required: ['tag'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_markup',
    title: 'Check markup against the components',
    description: "Find props a component doesn't have and events it doesn't fire in markup you wrote (HTML, JSX, Vue or Svelte), with the nearest real name. Run it on markup before showing it.",
    inputSchema: { type: 'object', properties: { markup: { type: 'string', description: 'The markup to check' } }, required: ['markup'], additionalProperties: false },
  },
];

function find(components, tag) {
  const component = components.find((c) => c.tag === tag || c.name === tag);
  if (!component) {
    const suggestion = nearest(String(tag), components.map((c) => c.tag));
    throw new ToolError(`no component "${tag}"${suggestion ? `; did you mean "${suggestion}"?` : ''} (list_components lists them)`);
  }
  return component;
}

class ToolError extends Error {}

function call(components, name, args = {}) {
  if (name === 'list_components') {
    const list = components.map(({ tag, name: className, description, origin }) => ({ tag, name: className, description: description.split('\n')[0], from: origin }));
    return { text: list.map((c) => `<${c.tag}> (${c.name}): ${c.description}`).join('\n') || 'No components.', structured: { components: list } };
  }
  if (name === 'describe_component') {
    const c = find(components, args.tag);
    const { origin, ...api } = c;
    const text = [
      `<${c.tag}> (${c.name})${origin ? `, from ${origin}` : ''}`,
      c.description,
      '',
      'Props:',
      ...c.props.map((p) => `- ${p.name}${p.attribute && p.attribute !== p.name ? ` (attribute ${p.attribute})` : ''}: ${p.type}, default ${JSON.stringify(p.default)}${c.models.includes(p.name) ? ', two-way' : ''}${p.description ? `. ${p.description}` : ''}`),
      'Events:',
      ...(c.events.length ? c.events.map((e) => `- ${e.name}: detail ${e.detail ?? 'none'}${e.description ? `. ${e.description}` : ''}`) : ['- none']),
      'Slots:',
      ...(c.slots.length ? c.slots.map((s) => `- ${s}`) : ['- none']),
    ].join('\n');
    return { text, structured: api };
  }
  if (name === 'component_usage') {
    const c = find(components, args.tag);
    const framework = args.framework ?? 'html';
    if (!FRAMEWORKS.includes(framework)) throw new ToolError(`framework must be one of ${FRAMEWORKS.join(', ')}`);
    const text = usage(c, framework);
    return { text, structured: { tag: c.tag, framework, code: text } };
  }
  if (name === 'check_markup') {
    if (typeof args.markup !== 'string') throw new ToolError('markup must be a string');
    const problems = check(components, args.markup);
    const text = problems.length
      ? problems.map((p) => `- ${p.problem}${p.suggestion ? ` (did you mean "${p.suggestion}"?)` : ''}`).join('\n')
      : 'No problems found: every prop and event used on these components exists.';
    return { text, structured: { problems } };
  }
  throw new ToolError(`no tool "${name}"`);
}

/** Answer one JSON-RPC message; returns the response, or null for a notification. */
export function handle(components, message) {
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  const fail = (code, text) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
  if (message.id === undefined) return null; // notifications (initialized, cancelled): nothing to say
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'zubra-components', title: 'Zubra components', version },
        instructions: `This library has ${components.length} web component${components.length === 1 ? '' : 's'}. Use describe_component before using one, component_usage for the framework you are writing, and check_markup on what you wrote.`,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const { text, structured } = call(components, message.params?.name, message.params?.arguments);
        return reply({ content: [{ type: 'text', text }], structuredContent: structured, isError: false });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return reply({ content: [{ type: 'text', text: error.message }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${message.method}`);
  }
}

/** Serve MCP over `input` and `output` (standard input and output by default) until input ends. */
export function serve(components, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    let response;
    try {
      response = handle(components, message);
    } catch (error) {
      response = { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: error.message } };
    }
    if (response) output.write(JSON.stringify(response) + '\n');
  });
  return new Promise((resolve) => lines.on('close', resolve));
}
