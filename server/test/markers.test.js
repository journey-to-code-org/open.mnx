// The hydration-marker contract, measured: the server's `<?zb [?>` … `<?zb ]?>` processing
// instructions through the HTML minifiers and sanitizers a page is likely to pass through on its
// way to the browser. docs/server-rendering.md ("Hydration markers through minifiers and
// sanitizers") quotes this table; a change here is a change to that page.
//
// Three outcomes, each asserted:
// - KEEP: the tool keeps the markers as it ships (as processing instructions, or as the
//   `<!--?zb [?-->` comments a pre-150 browser makes of them, which the runtime reads the same way);
// - CONFIGURE: the tool strips them by default, and the one option named here keeps them;
// - STRIP: the tool removes them whatever its options; the element then puts them back by
//   structure (remark.js; registry/test/stripped.test.js shows every registry component does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCompiler } from '../src/compiler.js';

const here = dirname(fileURLToPath(import.meta.url));
const registry = join(here, '../../registry/components');
findCompiler();
const { renderToString, ZUBRA_MARKER_PATTERN, ZUBRA_MARKER_DIRECTIVE } = await import('@zubra/compiler');

const MARKER = /<\?zb[^>]*\?>|<!--\?zb[^>]*-->/g;
const count = (html) => (html.match(MARKER) ?? []).length;

// Components whose server HTML carries markers of every kind: regions (`[`/`]`), browser-only
// regions (`[?`), slot content (`[!`) and text anchors.
// (`chat-message` formats times, which only the browser does: the browser-only regions. Since 5.12
// the server answers `hasSlot`, so `kanban-column` has none.)
const components = [['tag-input', false], ['accordion-panel', true], ['kanban-column', true], ['modal-dialog', true], ['chat-message', false]].map(([name, slotted]) => ({
  name,
  html: renderToString(join(registry, `${name}.zb`), { partial: true, slots: slotted ? { default: '<p>Slot content</p>' } : {} }),
}));

/** @type {Record<string, { expect: 'KEEP' | 'CONFIGURE' | 'STRIP', run: (html: string) => Promise<string> | string, note: string }>} */
const tools = {
  'html-minifier-terser': {
    expect: 'KEEP',
    note: 'removeComments: true, collapseWhitespace: true',
    run: async (html) => (await import('html-minifier-terser')).minify(html, { removeComments: true, collapseWhitespace: true }),
  },
  '@minify-html/node': {
    expect: 'KEEP',
    note: 'defaults (comments removed)',
    run: async (html) => (await import('@minify-html/node')).default.minify(Buffer.from(html), {}).toString(),
  },
  '@swc/html': {
    expect: 'CONFIGURE',
    note: 'defaults strip them as comments; `preserveComments: [ZUBRA_MARKER_PATTERN]` from @zubra/compiler (or `removeComments: false`) keeps them',
    run: async (html) => (await (await import('@swc/html')).minify(Buffer.from(html), { preserveComments: [ZUBRA_MARKER_PATTERN] })).code,
    unconfigured: async (html) => (await (await import('@swc/html')).minify(Buffer.from(html), {})).code,
  },
  htmlnano: {
    expect: 'CONFIGURE',
    note: 'its parser drops them; the posthtml parser option `directives: [ZUBRA_MARKER_DIRECTIVE]` from @zubra/compiler keeps them',
    run: async (html) => {
      const htmlnano = (await import('htmlnano')).default;
      const options = { minifyCss: false, minifySvg: false };
      return (await htmlnano.process(html, options, htmlnano.presets.max, { directives: [ZUBRA_MARKER_DIRECTIVE] })).html;
    },
    unconfigured: async (html) => {
      const htmlnano = (await import('htmlnano')).default;
      return (await htmlnano.process(html, { minifyCss: false, minifySvg: false }, htmlnano.presets.safe)).html;
    },
  },
  DOMPurify: {
    expect: 'STRIP',
    note: 'a sanitizer: removes comments and processing instructions (ADD_TAGS: ["#comment"] would keep them, at the cost of keeping every comment)',
    run: async (html) => {
      const { JSDOM } = await import('jsdom');
      const purify = (await import('dompurify')).default(new JSDOM('').window);
      return purify.sanitize(html, { CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /-/, attributeNameCheck: /.*/ } });
    },
  },
  'sanitize-html': {
    expect: 'STRIP',
    note: 'a sanitizer: removes them with every tag and attribute allowed',
    run: async (html) => (await import('sanitize-html')).default(html, { allowedTags: false, allowedAttributes: false, allowVulnerableTags: true }),
  },
};

// Before any tool: every sample has markers to lose.
for (const { name, html } of components) {
  assert.ok(count(html) >= 2, `${name}'s server HTML has markers (${count(html)})`);
}

test('hydration markers through minifiers and sanitizers (the table docs/server-rendering.md quotes)', async (t) => {
  const rows = [];
  for (const [tool, { expect, run, unconfigured, note }] of Object.entries(tools)) {
    for (const { name, html } of components) {
      const before = count(html);
      const after = count(await run(html));
      if (expect === 'STRIP') {
        assert.equal(after, 0, `${tool} strips every marker from ${name}`);
      } else {
        assert.equal(after, before, `${tool} keeps all ${before} markers of ${name} (kept ${after})`);
      }
      if (unconfigured) {
        assert.equal(count(await unconfigured(html)), 0, `${tool} without the option strips ${name}'s markers (so the option is needed)`);
      }
    }
    rows.push(`${tool}: ${expect} (${note})`);
  }
  t.diagnostic(rows.join('\n'));
});

test('a browser without processing-instruction parsing reads the same markers as comments', async () => {
  // jsdom follows the HTML parsing algorithm before Chrome 150's change: `<?zb [?>` is a bogus
  // comment whose data is `?zb [?`. The runtime accepts both node types (runtime/src/hydrate.js).
  const { JSDOM } = await import('jsdom');
  for (const { name, html } of components) {
    const dom = new JSDOM('<body></body>');
    dom.window.document.body.innerHTML = html;
    const round = dom.window.document.body.innerHTML;
    assert.equal(count(round), count(html), `${name}: every marker survives the round trip as a comment`);
    assert.match(round, /<!--\?zb \[\?-->/, `${name}: the comment form is what the runtime reads`);
  }
});

// Every registry component's markup is covered by the "stripped" suite; this one checks the
// sample above is a fair one: it holds every marker kind the compiler writes.
test('the samples carry every kind of marker', () => {
  const all = components.map(({ html }) => html).join('');
  for (const kind of ['<?zb [?>', '<?zb ]?>', '<?zb [??>', '<?zb [!?>', '<?zb ?>']) {
    assert.ok(all.includes(kind), `samples include ${kind}`);
  }
});
