// Embed mode: a folder of components as files any site can load with one script tag, and as
// add-ons for site builders that have no bundler: a WordPress plugin (shortcodes and blocks), a
// Shopify theme app extension (one block per component) and HTML snippets (Webflow's Embed
// element, Squarespace's code block, any CMS's HTML block).
//
//   import { buildEmbed } from '@zubra/compiler/embed';
//   buildEmbed('src/components', { out: 'embed', name: 'acme-widgets' });
//
// (or `npx zubra build --embed src/components`). The output:
//
//   <name>.js                   the entry: one <script type="module"> defines every component
//   <tag>.js, zubra-runtime-*   the components and the runtime they use (production build), all
//                               in one flat folder with relative imports, so it can be hosted
//                               anywhere, including asset folders that allow no subfolders
//   custom-elements.json        the Custom Elements Manifest
//   html/<tag>.html             a snippet per component: the script tag and the element
//   wordpress/<name>/           a plugin: [shortcode] and a block per component, the files in assets/
//   shopify/                    a theme app extension: a block per component, the files in assets/
//   README.md                   how to install each
//
// Everything a component imports must be in the folder: @zubra/runtime and the components'
// own relative imports. An npm package (a Zag machine, @zubra/sync) can't be embedded this way;
// the build says which component imports it.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFile } from './index.js';

const SOURCE = /\.zb(?:\.[jt]sx)?$/;
const walk = (dir) => readdirSync(dir).sort().flatMap((entry) => {
  const path = join(dir, entry);
  if (statSync(path).isDirectory()) return entry === 'node_modules' || entry.startsWith('.') ? [] : walk(path);
  return SOURCE.test(entry) ? [path] : [];
});

// Every module specifier: `import … from '…'`, `export … from '…'`, `import '…'` (each at the
// start of a statement) and dynamic `import('…')` with a literal.
const SPECIFIERS = /((?:^|[\n;])\s*(?:import|export)\b[^;'"`]*?\bfrom\s*|(?:^|[\n;])\s*import\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g;

/** The `@zubra/runtime` production build: the installed package, or this repository's. */
export function runtimeDirectory(from = process.cwd()) {
  try {
    const pkg = createRequire(join(resolve(from), 'package.json')).resolve('@zubra/runtime/package.json');
    return join(dirname(pkg), 'dist/production');
  } catch {
    const sibling = fileURLToPath(new URL('../runtime/dist/production', import.meta.url));
    if (existsSync(sibling)) return sibling;
    throw new Error('zubra build --embed: @zubra/runtime is not installed (npm install @zubra/runtime)');
  }
}

const title = (tag) => tag.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
const slugOf = (name) => name.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'zubra-components';
const html = (text) => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/** How each kind of prop is edited in a site builder, from its type. */
function kindOf(prop) {
  if (prop.type === 'string') return 'text';
  if (prop.type === 'number') return 'number';
  if (prop.type === 'boolean') return 'boolean';
  return 'json'; // arrays, objects, unions: JSON in the attribute, which the element parses
}
/** The attribute text for a prop's default, or null for none. */
function attributeDefault(prop) {
  const kind = kindOf(prop);
  if (prop.default === undefined || prop.default === null) return null;
  if (kind === 'boolean') return prop.default ? '' : null;
  if (kind === 'text' && prop.default === '') return null;
  if (kind === 'json') return JSON.stringify(prop.default);
  return String(prop.default);
}

/**
 * Build the embed folder for every component under `dir`. Returns `{ components, files }`;
 * throws on the first compile error, or when a component imports what can't be embedded.
 */
export function buildEmbed(dir, options = {}) {
  const root = resolve(dir);
  const target = resolve(options.out ?? 'embed');
  const out = `${target}.building`;
  const project = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {};
  const name = slugOf(options.name ?? project.name ?? 'zubra-components');
  const base = options.base ?? './';
  const runtimeDir = options.runtimeDir ?? runtimeDirectory();
  const sources = walk(root);
  if (!sources.length) throw new Error(`zubra build --embed: no components (.zb, .zb.jsx, .zb.tsx) in ${dir}`);
  if (target === root || root.startsWith(target + sep)) throw new Error('zubra build --embed: the output directory must not contain the components');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  try {
    const result = build();
    rmSync(target, { recursive: true, force: true });
    renameSync(out, target);
    return result;
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    throw error;
  }

  function build() {
    const write = (path, text) => {
      mkdirSync(dirname(join(out, path)), { recursive: true });
      writeFileSync(join(out, path), text);
    };
    const compile = (path, request) => {
      const response = compileFile(path, { runtime: '@zubra/runtime', ...request });
      if (!response.ok) throw new Error(response.error);
      return response;
    };

    // Each component, by source path (extension dropped, so `./card.js` finds `card.zb`).
    const components = [];
    const byStem = new Map();
    const modules = [];
    for (const path of sources) {
      const face = JSON.parse(compile(path, { emit: 'interface' }).output);
      const component = { path, tag: face.tag, props: face.props, events: face.events, form: face.form, file: `${face.tag}.js` };
      if (components.some((other) => other.tag === component.tag)) throw new Error(`zubra build --embed: <${component.tag}> is defined twice`);
      components.push(component);
      byStem.set(path.replace(SOURCE, ''), component);
      const manifest = JSON.parse(compile(path, { emit: 'manifest', modulePath: component.file }).output);
      modules.push(...manifest.modules);
      component.description = manifest.modules[0]?.declarations?.find((d) => d.customElement)?.description ?? '';
    }

    // Flatten: every file the components need, in one folder, imports rewritten to `./<flat>`.
    const written = new Map(); // key → flat name
    const pending = [];
    const flat = (key, name, load) => {
      if (!written.has(key)) {
        written.set(key, name);
        pending.push({ name, load });
      }
      return name;
    };
    const runtimeFile = (entry) => {
      const file = join(runtimeDir, `${entry}.js`);
      if (!existsSync(file)) throw new Error(`zubra build --embed: the runtime has no ${entry}.js (in ${runtimeDir})`);
      return flat(file, `zubra-runtime-${entry}.js`, () => ({ code: readFileSync(file, 'utf8'), from: file }));
    };
    const resolveFrom = (from, specifier, who) => {
      if (specifier === '@zubra/runtime') return runtimeFile('index');
      if (specifier.startsWith('@zubra/runtime/')) return runtimeFile(specifier.slice('@zubra/runtime/'.length));
      if (from.runtime && specifier.startsWith('./')) return runtimeFile(specifier.slice(2).replace(/\.js$/, ''));
      if (!specifier.startsWith('.')) {
        throw new Error(`zubra build --embed: ${who} imports "${specifier}", an npm package; an embed build can only include @zubra/runtime and files next to the components. Load it on the page yourself, or build with --lib for a bundler.`);
      }
      const absolute = resolve(dirname(from.path), specifier);
      const component = byStem.get(absolute.replace(/\.js$/, ''));
      if (component) return component.file;
      if (!existsSync(absolute)) throw new Error(`zubra build --embed: ${who} imports "${specifier}", which doesn't exist`);
      const module = relative(root, absolute).split(sep).join('-').replace(/[^\w.-]/g, '-');
      return flat(absolute, `module-${module}`, () => ({ code: readFileSync(absolute, 'utf8'), from: absolute }));
    };
    const rewrite = (code, from, who) => code.replace(SPECIFIERS, (match, head, quote, specifier) =>
      `${head}${quote}./${resolveFrom(from, specifier, who)}${quote}`);

    for (const component of components) {
      const js = compile(component.path, { emit: 'js' });
      write(component.file, rewrite(js.output, { path: component.path }, `<${component.tag}> (${relative(process.cwd(), component.path)})`));
    }
    while (pending.length) {
      const { name: file, load } = pending.shift();
      const { code, from } = load();
      const isRuntime = from.startsWith(runtimeDir);
      write(file, rewrite(code, { path: from, runtime: isRuntime }, isRuntime ? `the runtime's ${file}` : relative(process.cwd(), from)));
    }

    const entry = `${name}.js`;
    write(entry, `// Defines every component in ${name}: load it once per page.\n${components.map((c) => `import './${c.file}';`).join('\n')}\n`);
    write('custom-elements.json', JSON.stringify({ schemaVersion: '2.1.0', readme: '', modules }, null, 2) + '\n');
    const js = readdirSync(out).filter((file) => file.endsWith('.js'));

    // HTML snippets: the script tag, and the element with its defaults written out.
    for (const component of components) {
      const attributes = component.props.map((prop) => {
        const value = attributeDefault(prop);
        return value === null ? '' : value === '' ? ` ${prop.attribute}` : ` ${prop.attribute}="${html(value)}"`;
      }).join('');
      write(`html/${component.tag}.html`, `<script type="module" src="${base}${entry}"></script>\n<${component.tag}${attributes}></${component.tag}>\n`);
    }

    const copy = (into) => { for (const file of js) cpSync(join(out, file), join(out, into, file)); };
    wordpress(write, copy, name, entry, components);
    shopify(write, copy, name, entry, components);
    write('README.md', readme(name, entry, components));
    return { components: components.map(({ tag, file }) => ({ tag, file })), files: js };
  }
}

// ---- WordPress ---------------------------------------------------------------------------------
//
// One plugin: the JS in assets/, registered as a script module (WordPress 6.5+); a shortcode per
// component (`[star_rating max="10"]`, attributes as the element's, content as its children);
// and a dynamic block per component with a sidebar field per prop, rendered by the same PHP.

function wordpress(write, copy, name, entry, components) {
  const dir = `wordpress/${name}`;
  copy(`${dir}/assets`);
  const php = (value) => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  const fn = name.replace(/-/g, '_');
  const definitions = components.map((component) => {
    const props = component.props.map((prop) => {
      const kind = kindOf(prop);
      const fallback = attributeDefault(prop);
      return `      ${php(prop.attribute)} => array( 'kind' => ${php(kind)}, 'default' => ${fallback === null ? 'null' : php(fallback)} ),`;
    }).join('\n');
    return `  ${php(component.tag)} => array(
    'title' => ${php(title(component.tag))},
    'description' => ${php(component.description ?? '')},
    'props' => array(
${props}
    ),
  ),`;
  }).join('\n');
  write(`${dir}/${name}.php`, `<?php
/**
 * Plugin Name: ${title(name)}
 * Description: ${components.length} web component${components.length === 1 ? '' : 's'} built with Zubra, as shortcodes and blocks: ${components.map((c) => `[${c.tag.replace(/-/g, '_')}]`).join(', ')}.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 7.4
 *
 * Generated by \`zubra build --embed\`. Rebuild rather than editing it.
 */

if ( ! defined( 'ABSPATH' ) ) {
  exit;
}

function ${fn}_components() {
  return array(
${definitions}
  );
}

/** The element's HTML: attributes from the given values (missing ones use the component's default). */
function ${fn}_render( $tag, $values, $content = '' ) {
  $components = ${fn}_components();
  if ( ! isset( $components[ $tag ] ) ) {
    return '';
  }
  wp_enqueue_script_module( ${php(name)} );
  // A shortcode's bare attribute (\`[toggle_switch checked]\`) arrives under a number.
  foreach ( $values as $key => $value ) {
    if ( is_int( $key ) && is_string( $value ) ) {
      $values[ strtolower( $value ) ] = true;
    }
  }
  $html = '<' . $tag;
  foreach ( $components[ $tag ]['props'] as $attribute => $prop ) {
    $key = isset( $values[ $attribute ] ) ? $attribute : str_replace( '-', '_', $attribute );
    if ( ! isset( $values[ $key ] ) || '' === $values[ $key ] ) {
      continue;
    }
    $value = $values[ $key ];
    if ( 'boolean' === $prop['kind'] ) {
      if ( true === $value || 'true' === $value || '1' === $value || 1 === $value ) {
        $html .= ' ' . $attribute;
      }
      continue;
    }
    if ( 'json' === $prop['kind'] && ! is_string( $value ) ) {
      $value = wp_json_encode( $value );
    }
    $html .= ' ' . $attribute . '="' . esc_attr( (string) $value ) . '"';
  }
  return $html . '>' . $content . '</' . $tag . '>';
}

add_action( 'init', function () {
  wp_register_script_module( ${php(name)}, plugins_url( ${php(`assets/${entry}`)}, __FILE__ ), array(), '1.0.0' );
  wp_register_script(
    ${php(`${name}-editor`)},
    plugins_url( 'editor.js', __FILE__ ),
    array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-server-side-render' ),
    '1.0.0',
    true
  );
  foreach ( ${fn}_components() as $tag => $component ) {
    add_shortcode( str_replace( '-', '_', $tag ), function ( $attributes, $content = '' ) use ( $tag ) {
      return ${fn}_render( $tag, (array) $attributes, do_shortcode( (string) $content ) );
    } );
    $block_attributes = array();
    foreach ( $component['props'] as $attribute => $prop ) {
      $type = array( 'text' => 'string', 'json' => 'string', 'number' => 'number', 'boolean' => 'boolean' );
      $block_attributes[ str_replace( '-', '_', $attribute ) ] = array( 'type' => $type[ $prop['kind'] ] );
    }
    register_block_type( ${php(name)} . '/' . $tag, array(
      'api_version' => 3,
      'title' => $component['title'],
      'category' => 'widgets',
      'attributes' => $block_attributes,
      'editor_script' => ${php(`${name}-editor`)},
      'render_callback' => function ( $attributes ) use ( $tag ) {
        return ${fn}_render( $tag, (array) $attributes );
      },
    ) );
  }
} );

// The editor shows the blocks with the components running, so they load there too.
add_action( 'enqueue_block_assets', function () {
  if ( is_admin() ) {
    wp_enqueue_script_module( ${php(name)} );
  }
} );
`);

  // The editor: a block per component, previewed by the server render, a sidebar field per prop.
  const blocks = components.map((component) => ({
    name: `${name}/${component.tag}`,
    title: title(component.tag),
    fields: component.props.map((prop) => ({ key: prop.attribute.replace(/-/g, '_'), label: prop.name, kind: kindOf(prop) })),
  }));
  write(`${dir}/editor.js`, `// Generated by \`zubra build --embed\`: the ${name} blocks in the editor. No build step needed.
(function (wp) {
  var el = wp.element.createElement;
  var InspectorControls = wp.blockEditor.InspectorControls;
  var useBlockProps = wp.blockEditor.useBlockProps;
  var C = wp.components;
  var ServerSideRender = wp.serverSideRender;
  var blocks = ${JSON.stringify(blocks, null, 2).replace(/\n/g, '\n  ')};
  function field(spec, attributes, setAttributes) {
    var value = attributes[spec.key];
    var set = function (next) { var change = {}; change[spec.key] = next; setAttributes(change); };
    if (spec.kind === 'boolean') return el(C.ToggleControl, { key: spec.key, label: spec.label, checked: !!value, onChange: set });
    if (spec.kind === 'number') return el(C.TextControl, { key: spec.key, label: spec.label, type: 'number', value: value === undefined ? '' : value, onChange: function (v) { set(v === '' ? undefined : Number(v)); } });
    if (spec.kind === 'json') return el(C.TextareaControl, { key: spec.key, label: spec.label + ' (JSON)', value: value || '', onChange: set });
    return el(C.TextControl, { key: spec.key, label: spec.label, value: value || '', onChange: set });
  }
  blocks.forEach(function (block) {
    wp.blocks.registerBlockType(block.name, {
      apiVersion: 3,
      title: block.title,
      category: 'widgets',
      icon: 'screenoptions',
      edit: function (props) {
        return el('div', useBlockProps(),
          el(InspectorControls, null, el(C.PanelBody, { title: 'Settings' }, block.fields.map(function (spec) { return field(spec, props.attributes, props.setAttributes); }))),
          el(ServerSideRender, { block: block.name, attributes: props.attributes }));
      },
      save: function () { return null; },
    });
  });
})(window.wp);
`);
}

// ---- Shopify -----------------------------------------------------------------------------------
//
// A theme app extension: the JS in assets/ (Shopify's asset folder is flat, which the build
// already is), and a block per component whose settings are its props.

function shopify(write, copy, name, entry, components) {
  copy('shopify/assets');
  write('shopify/shopify.extension.toml', `# Generated by \`zubra build --embed\`. Copy this folder to extensions/${name} in your Shopify app.
name = "${title(name)}"
type = "theme"
`);
  for (const component of components) {
    const settings = [];
    const attributes = [];
    for (const prop of component.props) {
      const id = prop.attribute.replace(/-/g, '_');
      const kind = kindOf(prop);
      const setting = { type: { text: 'text', number: 'number', boolean: 'checkbox', json: 'textarea' }[kind], id, label: prop.name.slice(0, 50) };
      if (kind === 'boolean') setting.default = Boolean(prop.default);
      else if (kind === 'number' && typeof prop.default === 'number') setting.default = prop.default;
      else if (kind === 'text' && typeof prop.default === 'string' && prop.default) setting.default = prop.default;
      else if (kind === 'json' && prop.default !== undefined) setting.default = JSON.stringify(prop.default);
      if (kind === 'json') setting.info = 'JSON';
      settings.push(setting);
      if (kind === 'boolean') attributes.push(`{% if block.settings.${id} %} ${prop.attribute}{% endif %}`);
      else attributes.push(`{% if block.settings.${id} != blank %} ${prop.attribute}="{{ block.settings.${id} | escape }}"{% endif %}`);
    }
    const schema = { name: title(component.tag).slice(0, 25), target: 'section', settings };
    write(`shopify/blocks/${component.tag}.liquid`, `<script type="module" src="{{ '${entry}' | asset_url }}"></script>
<${component.tag} {{ block.shopify_attributes }}${attributes.join('')}></${component.tag}>

{% schema %}
${JSON.stringify(schema, null, 2)}
{% endschema %}
`);
  }
}

function readme(name, entry, components) {
  return `# ${name}: embed build

Generated by \`zubra build --embed\`. ${components.length} component${components.length === 1 ? '' : 's'}: ${components.map((c) => `\`<${c.tag}>\``).join(', ')}.

## Any site

Host the \`.js\` files in this folder together (any static host or CDN; they import each other by relative path), then on a page:

\`\`\`html
<script type="module" src="https://your-host/${entry}"></script>
<${components[0].tag}></${components[0].tag}>
\`\`\`

\`html/\` has a snippet per component, with its attributes and their defaults. Rebuild with \`--base https://your-host/\` to write the full URL into them.

## Webflow, Squarespace, Wix and other site builders

Host the files as above. Paste the snippet from \`html/\` into an Embed element (Webflow), a Code block (Squarespace) or an HTML embed, or put the \`<script>\` once in the site's custom code and only the element in each embed.

## WordPress

Copy \`wordpress/${name}\` into \`wp-content/plugins/\` (or zip it and upload it) and activate it. WordPress 6.5 or later. Each component is then:

- a **block** in the editor's Widgets category, with a sidebar field per prop;
- a **shortcode**: ${components.map((c) => `\`[${c.tag.replace(/-/g, '_')}]\``).join(', ')}. Attributes are the element's (\`[${components[0].tag.replace(/-/g, '_')} ${components[0].props[0]?.attribute ?? 'label'}="…"]\`), and content between an opening and closing shortcode goes into the element's slots.

## Shopify

Copy \`shopify/\` to \`extensions/${name}\` in your Shopify app and run \`shopify app deploy\`. Each component is an app block a merchant can add to a section in the theme editor, with a setting per prop.

Props that take arrays or objects are JSON text in each of these (an attribute, a textarea setting).
`;
}
