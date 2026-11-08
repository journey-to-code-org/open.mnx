// The zubra playground: the WebAssembly compiler in the page, the component running in plain
// HTML (and in React and Vue, when the site was built with them), and every compiler output.
// No server: state lives in the URL (#…), so a link is the whole example.

const PATH = '/playground/component.zb';

const EXAMPLES = {
  counter: {
    label: 'Counter',
    page: '<hello-counter label="Apples"></hello-counter>\n<hello-counter count="5"></hello-counter>',
    source: `<!--
  Props are declared on the host tag, with their defaults. \`count:model\` is two-way:
  assigning it fires \`countchange\`.
-->
<script>
  const atMin = count <= 0
</script>
<style>
  :host { display: inline-flex; align-items: center; gap: 0.75rem; margin: 0.5rem; font: 1rem system-ui; }
  button { width: 2rem; height: 2rem; border-radius: 50%; border: 1px solid #ccd; background: white; cursor: pointer; }
  button:disabled { opacity: 0.4; }
</style>
<hello-counter count:model={0} label="Clicks">
  <button type="button" class="less" disabled={atMin} onclick={() => count--}>−</button>
  <output>{label}: {count}</output>
  <button type="button" class="more" onclick={() => count++}>+</button>
</hello-counter>
`,
  },
  list: {
    label: 'List and directives',
    page: '<todo-list></todo-list>',
    source: `<script>
  let items = [{ id: 1, text: "Write a component", done: true }, { id: 2, text: "Ship it", done: false }]
  let draft = ""
  const left = items.filter((item) => !item.done).length

  function add() {
    if (!draft.trim()) return
    items = [...items, { id: Date.now(), text: draft.trim(), done: false }]
    draft = ""
  }
  function toggle(id) {
    items = items.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
  }
</script>
<style>
  :host { display: block; max-width: 22rem; font: 15px system-ui; }
  li { display: flex; gap: 0.5rem; padding: 0.2rem 0; cursor: pointer; }
  li.done { text-decoration: line-through; opacity: 0.55; }
</style>
<todo-list>
  <form onsubmit.prevent={add}>
    <input aria-label="New item" value={draft} oninput={(event) => (draft = event.target.value)}>
    <button>Add</button>
  </form>
  <ul>
    <zb-each items={items} as="item" key={item.id}>
      <li class:done={item.done} onclick={() => toggle(item.id)}>{item.text}</li>
    </zb-each>
  </ul>
  <p>{left} left</p>
</todo-list>
`,
  },
  slots: {
    label: 'Slots',
    page: '<info-card heading="With a footer">\n  <p>Body text.</p>\n  <small slot="footer">Footer</small>\n</info-card>\n<info-card heading="Without one">\n  <p>No footer here.</p>\n</info-card>',
    source: `<script>
  import { hasSlot } from '@zubra/runtime'

  const hasFooter = hasSlot('footer')
</script>
<style>
  :host { display: block; margin: 0.5rem; border: 1px solid #dde; border-radius: 0.6rem; padding: 0.5rem 1rem; font: 15px system-ui; }
  footer { border-top: 1px solid #dde; padding-top: 0.4rem; color: #667; }
</style>
<info-card heading="Card">
  <h3>{heading}</h3>
  <zb-slot><p>Nothing here yet.</p></zb-slot>
  <footer zb-if={hasFooter}><zb-slot name="footer"></zb-slot></footer>
</info-card>
`,
  },
  spread: {
    label: 'Spread',
    page: '<disclosure-panel heading="What does {...} do?"></disclosure-panel>',
    source: `<!--
  {...object} puts an object's entries on an element: attributes, on<Name> listeners, and
  properties such as value. It's how a headless library hands out a widget's behaviour.
-->
<script>
  import { id } from '@zubra/runtime'

  let open = false
  const panelId = id()
  // A tiny "prop getter", the shape Zag.js and other headless libraries use.
  const trigger = {
    "aria-expanded": open,
    "aria-controls": panelId,
    onClick: () => (open = !open),
  }
  const panel = { id: panelId, hidden: !open, role: "region" }
</script>
<style>
  :host { display: block; margin: 0.5rem; font: 15px system-ui; }
  button { font: inherit; padding: 0.4rem 0.8rem; border: 1px solid #ccd; border-radius: 0.5rem; background: white; cursor: pointer; }
  [role=region] { margin-top: 0.5rem; padding: 0.5rem 0.8rem; border-left: 3px solid #36c; }
</style>
<disclosure-panel heading="Details">
  <button type="button" {...trigger}>{heading}</button>
  <div {...panel}>An attribute written on the element wins over the spread, and a spread can't do anything an attribute couldn't.</div>
</disclosure-panel>
`,
  },
  conditions: {
    label: 'Conditions',
    page: '<cart-summary></cart-summary>',
    source: `<!--
  Conditions without wrappers: zb-if as an attribute on one element, and markup in braces in
  the three forms that are directives (&&, ? : and a keyed .map).
-->
<script>
  let items = []
  let next = 1
  const total = items.reduce((sum, item) => sum + item.price, 0)
  function add() { items.push({ id: next, name: \`Item \${next}\`, price: next * 3 }); next++ }
</script>
<style>
  :host { display: block; margin: 0.5rem; font: 15px system-ui; }
  button { font: inherit; padding: 0.3rem 0.7rem; }
</style>
<cart-summary>
  <p zb-if={items.length === 0}>Your cart is empty.</p>
  <p zb-else-if={items.length < 3}>A few things so far.</p>
  <p zb-else>That's a full cart.</p>
  <ul>{items.map((item) => <li key={item.id}>{item.name}: \${item.price}</li>)}</ul>
  {total > 10 && <strong>Free shipping!</strong>}
  <button type="button" onclick={add}>Add an item</button>
</cart-summary>
`,
  },
};

const $ = (selector) => document.querySelector(selector);
const source = $('#source');
const page = $('#page');
const status = $('#status');

// ---- the compiler ---------------------------------------------------------------------------

/**
 * The compiler: zubra.wasm (the same module as @zubra/compiler, the same output as the CLI), or,
 * when the site is served without it (`node playground/serve.mjs`), the server's `zubra request`.
 */
async function loadCompiler() {
  try {
    const response = await fetch('zubra.wasm');
    if (!response.ok) throw new Error(String(response.status));
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    const { memory, zubra_alloc, zubra_request, zubra_free } = instance.exports;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return {
      kind: 'WebAssembly',
      async request(body) {
        const bytes = encoder.encode(JSON.stringify(body));
        const pointer = zubra_alloc(bytes.length);
        new Uint8Array(memory.buffer, pointer, bytes.length).set(bytes);
        const packed = BigInt.asUintN(64, zubra_request(pointer, bytes.length));
        const at = Number(packed >> 32n);
        const length = Number(packed & 0xffffffffn);
        const text = decoder.decode(new Uint8Array(memory.buffer, at, length).slice());
        zubra_free(at, length);
        return JSON.parse(text);
      },
    };
  } catch {
    const probe = await fetch('__zubra/request', { method: 'POST', body: '{}' }).catch(() => null);
    if (!probe || probe.status === 404) throw new Error('zubra.wasm is missing from this site');
    return {
      kind: 'server',
      async request(body) {
        return (await fetch('__zubra/request', { method: 'POST', body: JSON.stringify(body) })).json();
      },
    };
  }
}

const compile = (compiler, text, emit, extra = {}) =>
  compiler.request({ path: PATH, files: { [PATH]: text }, emit, runtime: '@zubra/runtime', ...extra });

// ---- previews -------------------------------------------------------------------------------

const runtimeUrl = new URL('runtime/', location.href).href;
const vendorUrl = new URL('vendor/', location.href).href;
let frameworks = []; // the framework previews this site was built with (vendor/frameworks.json)

const importMap = () => JSON.stringify({
  imports: {
    '@zubra/runtime': `${runtimeUrl}index.js`,
    '@zubra/runtime/spread': `${runtimeUrl}spread.js`,
    '@zubra/runtime/primitives': `${runtimeUrl}primitives.js`,
    '@zubra/runtime/': runtimeUrl,
    '@zubra/runtime/react': `${runtimeUrl}react.js`,
    '@zubra/runtime/vue': `${runtimeUrl}vue.js`,
    react: `${vendorUrl}react.js`,
    'react-dom/client': `${vendorUrl}react.js`,
    vue: `${vendorUrl}vue.js`,
  },
});

/** The compiled module as an inline script (its default export kept as `Component`). */
const inline = (code) => code.replace(/^export default /m, 'const Component = ').replace(/<\/script/gi, '<\\/script');

const document_ = (body, script) => `<!doctype html><meta charset="utf-8">
<style>body { margin: 0.75rem; font: 15px system-ui, sans-serif; color: #1c2030; }</style>
<script type="importmap">${importMap()}</script>
<body>${body}</body>
<script type="module">
window.addEventListener('error', (event) => parent.postMessage({ zubraPreviewError: String(event.message) }, '*'));
${script}
window.previewReady = true;
</script>`;

const PREVIEWS = {
  html: { label: 'Plain HTML', doc: (code, markup) => document_(markup, inline(code)) },
  react: {
    label: 'React',
    doc: (code) => document_('<div id="root"></div>', `${inline(code)}
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { wrap } from '@zubra/runtime/react';
const Wrapped = wrap(Component);
createRoot(document.getElementById('root')).render(createElement(Wrapped));`),
  },
  vue: {
    label: 'Vue',
    doc: (code) => document_('<div id="root"></div>', `${inline(code)}
import { createApp, h } from 'vue';
import { wrap } from '@zubra/runtime/vue';
const Wrapped = wrap(Component);
createApp({ render: () => h(Wrapped) }).mount('#root');`),
  },
};

function showPreviews(code) {
  const box = $('#previews');
  const kinds = ['html', ...frameworks];
  box.replaceChildren(...kinds.map((kind) => {
    const section = document.createElement('div');
    section.className = 'preview';
    section.dataset.preview = kind;
    const heading = document.createElement('h2');
    heading.textContent = PREVIEWS[kind].label;
    const frame = document.createElement('iframe');
    frame.title = `${PREVIEWS[kind].label} preview`;
    frame.srcdoc = PREVIEWS[kind].doc(code, page.value);
    section.append(heading, frame);
    return section;
  }));
}

// ---- state in the URL -----------------------------------------------------------------------

async function encode(value) {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decode(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}

// ---- the page -------------------------------------------------------------------------------

function showTab(name) {
  for (const tab of document.querySelectorAll('[role=tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
}

async function main() {
  const select = $('#example');
  for (const [key, example] of Object.entries(EXAMPLES)) select.add(new Option(example.label, key));

  let initial = EXAMPLES.counter;
  if (location.hash.length > 1) {
    try {
      initial = await decode(location.hash.slice(1));
      select.value = '';
    } catch {
      status.textContent = "That link's example couldn't be read; showing the counter";
    }
  }
  source.value = initial.source;
  page.value = initial.page;

  try {
    frameworks = (await (await fetch('vendor/frameworks.json')).json()).filter((kind) => kind in PREVIEWS);
  } catch {
    frameworks = [];
  }

  let compiler;
  try {
    compiler = await loadCompiler();
  } catch (error) {
    status.textContent = `The compiler couldn't load: ${error.message}`;
    return;
  }

  let run = 0;
  async function update() {
    const mine = ++run;
    const text = source.value;
    const [js, html, dts, manifest] = await Promise.all([
      compile(compiler, text, 'js'),
      compile(compiler, text, 'html', { partial: true }),
      compile(compiler, text, 'dts'),
      compile(compiler, text, 'manifest'),
    ]);
    if (mine !== run) return; // a newer edit is on its way
    const error = $('#error');
    if (!js.ok) {
      error.hidden = false;
      error.textContent = js.error;
      status.textContent = 'Compile error';
      return;
    }
    error.hidden = !js.warnings.length;
    error.textContent = js.warnings.join('\n');
    $('#out-js').textContent = js.output;
    $('#out-html').textContent = html.ok ? html.output : html.error;
    $('#out-dts').textContent = dts.ok ? dts.output : dts.error;
    $('#out-manifest').textContent = manifest.ok ? manifest.output : manifest.error;
    showPreviews(js.output);
    status.textContent = `Compiled (${compiler.kind})`;
    const hash = await encode({ source: text, page: page.value });
    history.replaceState(null, '', `#${hash}`);
  }

  let timer;
  const soon = () => { clearTimeout(timer); timer = setTimeout(update, 250); };
  source.addEventListener('input', soon);
  page.addEventListener('input', soon);
  for (const area of [source, page]) {
    area.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      soon();
    });
  }
  select.addEventListener('change', () => {
    const example = EXAMPLES[select.value];
    if (!example) return;
    source.value = example.source;
    page.value = example.page;
    update();
  });
  $('#tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[role=tab]');
    if (tab) showTab(tab.dataset.tab);
  });
  $('#share').addEventListener('click', async () => {
    await update();
    try {
      await navigator.clipboard.writeText(location.href);
      status.textContent = 'Link copied';
    } catch {
      status.textContent = 'Copy the address bar to share';
    }
  });
  window.addEventListener('message', (event) => {
    if (event.data?.zubraPreviewError) {
      const error = $('#error');
      error.hidden = false;
      error.textContent = `In the preview: ${event.data.zubraPreviewError}`;
    }
  });
  await update();
  window.playgroundReady = true;
}

main();
