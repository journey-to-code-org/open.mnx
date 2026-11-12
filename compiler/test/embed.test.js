// Embed mode (embed.js): a folder of registry components built for sites without a bundler.
// The flat folder loads in a browser from one script tag; the WordPress plugin's PHP renders
// shortcodes and blocks (run under PHP with WordPress's functions stubbed); the Shopify blocks
// render with LiquidJS. The browser and PHP parts skip when Playwright (from ../runtime) or PHP
// isn't there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Liquid } from 'liquidjs';
import { buildEmbed } from '../embed.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'zb-embed-'));
const out = join(dir, 'embed');
let result;

before(() => {
  mkdirComponents();
  result = buildEmbed(join(dir, 'components'), { out, name: 'Acme Widgets' });
});
after(() => rmSync(dir, { recursive: true, force: true }));

function mkdirComponents() {
  const components = join(dir, 'components');
  mkdirSync(components, { recursive: true });
  for (const name of ['star-rating', 'toggle-switch', 'tag-input']) {
    cpSync(join(repo, 'registry/components', `${name}.zb`), join(components, `${name}.zb`));
  }
  mkdirSync(components, { recursive: true });
  // A component with a child component and a plain module next to it, in a subfolder.
  writeFileSync(join(components, 'greeting-card.zb'), `<script>
  import Badge from './parts/name-badge.zb'
  import { greet } from './parts/greet.js'
</script>
<greeting-card name="World">
  <name-badge text={greet(name)}></name-badge>
</greeting-card>
`);
  mkdirSync(join(components, 'parts'), { recursive: true });
  writeFileSync(join(components, 'parts/name-badge.zb'), '<name-badge text="">\n  <b>{text}</b>\n</name-badge>\n');
  writeFileSync(join(components, 'parts/greet.js'), "export const greet = (name) => `Hello, ${name}`;\n");
}

test('one flat folder: an entry, each component, the runtime it needs, every import relative', () => {
  assert.deepEqual(result.components.map((c) => c.tag), ['greeting-card', 'name-badge', 'star-rating', 'tag-input', 'toggle-switch']);
  const files = readdirSync(out).filter((file) => file.endsWith('.js'));
  assert.ok(files.includes('acme-widgets.js') && files.includes('zubra-runtime-index.js') && files.includes('zubra-runtime-signal.js'));
  assert.deepEqual(files.filter((file) => file.startsWith('module-')), ['module-parts-greet.js'], 'the runtime keeps its own names; a plain module is named by its path');
  for (const file of files) {
    const code = readFileSync(join(out, file), 'utf8');
    for (const [, specifier] of code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.match(specifier, /^\.\/[\w.-]+\.js$/, `${file} imports ${specifier}`);
      assert.ok(files.includes(specifier.slice(2)), `${file} imports ${specifier}, which is in the folder`);
    }
  }
  assert.match(readFileSync(join(out, 'acme-widgets.js'), 'utf8'), /import '\.\/star-rating\.js';/);
  const manifest = JSON.parse(readFileSync(join(out, 'custom-elements.json'), 'utf8'));
  assert.equal(manifest.modules.length, 5);
  assert.equal(readFileSync(join(out, 'html/star-rating.html'), 'utf8'),
    '<script type="module" src="./acme-widgets.js"></script>\n<star-rating value="0" max="5" label="Rating"></star-rating>\n');
  assert.ok(!readFileSync(join(out, 'html/toggle-switch.html'), 'utf8').includes('description'), 'an empty-string default is left out');
  for (const target of ['wordpress/acme-widgets/assets', 'shopify/assets']) {
    assert.deepEqual(readdirSync(join(out, target)).sort(), files.sort(), `${target} has every file`);
  }
});

test('an npm package a component imports is refused, naming the component', () => {
  const bad = mkdtempSync(join(tmpdir(), 'zb-embed-bad-'));
  cpSync(join(repo, 'registry/components/combo-box.zb'), join(bad, 'combo-box.zb'));
  assert.throws(() => buildEmbed(bad, { out: join(bad, '..', `${Date.now()}-out`) }), /<combo-box>.*imports "@zag-js\/combobox", an npm package/);
  rmSync(bad, { recursive: true, force: true });
});

test('Shopify: each block renders its element from the settings', async () => {
  const liquid = new Liquid({ strictFilters: true });
  liquid.registerFilter('asset_url', (file) => `https://cdn.shopify.test/assets/${file}`);
  const source = readFileSync(join(out, 'shopify/blocks/star-rating.liquid'), 'utf8');
  const schema = JSON.parse(source.match(/{% schema %}([\s\S]*){% endschema %}/)[1]);
  assert.deepEqual(schema.settings.map((s) => [s.id, s.type, s.default]), [
    ['value', 'number', 0], ['max', 'number', 5], ['required', 'checkbox', false], ['readonly', 'checkbox', false], ['label', 'text', 'Rating'],
  ]);
  const template = source.replace(/{% schema %}[\s\S]*{% endschema %}/, '');
  const html = await liquid.parseAndRender(template, { block: { shopify_attributes: 'data-block', settings: { value: 3, max: 5, required: true, readonly: false, label: 'Stars & "more"' } } });
  assert.equal(html.trim(), '<script type="module" src="https://cdn.shopify.test/assets/acme-widgets.js"></script>\n<star-rating data-block value="3" max="5" required label="Stars &amp; &#34;more&#34;"></star-rating>');
  const toml = readFileSync(join(out, 'shopify/shopify.extension.toml'), 'utf8');
  assert.match(toml, /type = "theme"/);
});

const php = spawnSync('php', ['--version']).status === 0;
test('WordPress: the plugin is valid PHP, and its shortcodes and blocks render the elements', { skip: !php && 'no PHP' }, () => {
  const plugin = join(out, 'wordpress/acme-widgets/acme-widgets.php');
  assert.match(execFileSync('php', ['-l', plugin], { encoding: 'utf8' }), /No syntax errors/);
  const harness = join(dir, 'harness.php');
  writeFileSync(harness, `<?php
define('ABSPATH', '/');
$GLOBALS['shortcodes'] = []; $GLOBALS['blocks'] = []; $GLOBALS['modules'] = []; $GLOBALS['actions'] = [];
function add_action($hook, $fn) { $GLOBALS['actions'][$hook][] = $fn; }
function add_shortcode($tag, $fn) { $GLOBALS['shortcodes'][$tag] = $fn; }
function register_block_type($name, $args) { $GLOBALS['blocks'][$name] = $args; }
function wp_register_script_module($id, $src) { $GLOBALS['registered'][$id] = $src; }
function wp_register_script() {}
function wp_enqueue_script_module($id) { $GLOBALS['modules'][$id] = true; }
function plugins_url($path, $file) { return 'https://site.test/plugins/acme-widgets/' . $path; }
function esc_attr($text) { return htmlspecialchars($text, ENT_QUOTES); }
function wp_json_encode($value) { return json_encode($value); }
function do_shortcode($content) { return $content; }
function is_admin() { return false; }
require ${JSON.stringify(plugin)};
foreach ($GLOBALS['actions']['init'] as $fn) { $fn(); }
$s = $GLOBALS['shortcodes'];
echo json_encode([
  'shortcodes' => array_keys($s),
  'rating' => $s['star_rating'](['value' => '4', 'label' => 'A "b"'], ''),
  'bare' => $s['toggle_switch']([0 => 'checked', 'label' => 'On'], ''),
  'content' => $s['greeting_card'](['name' => 'Ada'], '<p>hi</p>'),
  'block' => $GLOBALS['blocks']['acme-widgets/tag-input']['render_callback'](['value' => '["a","b"]', 'max' => 3]),
  'attributes' => $GLOBALS['blocks']['acme-widgets/star-rating']['attributes'],
  'module' => $GLOBALS['registered']['acme-widgets'],
  'enqueued' => array_keys($GLOBALS['modules']),
]);
`);
  const rendered = JSON.parse(execFileSync('php', [harness], { encoding: 'utf8' }));
  assert.deepEqual(rendered.shortcodes, ['greeting_card', 'name_badge', 'star_rating', 'tag_input', 'toggle_switch']);
  assert.equal(rendered.rating, '<star-rating value="4" label="A &quot;b&quot;"></star-rating>');
  assert.equal(rendered.bare, '<toggle-switch checked label="On"></toggle-switch>', 'a bare shortcode attribute is a boolean prop set');
  assert.equal(rendered.content, '<greeting-card name="Ada"><p>hi</p></greeting-card>', 'content goes inside the element');
  assert.equal(rendered.block, '<tag-input value="[&quot;a&quot;,&quot;b&quot;]" max="3"></tag-input>');
  assert.deepEqual(rendered.attributes, { value: { type: 'number' }, max: { type: 'number' }, required: { type: 'boolean' }, readonly: { type: 'boolean' }, label: { type: 'string' } });
  assert.equal(rendered.module, 'https://site.test/plugins/acme-widgets/assets/acme-widgets.js');
  assert.deepEqual(rendered.enqueued, ['acme-widgets'], 'the components load on a page that uses one');
  assert.doesNotThrow(() => execFileSync('node', ['--check', join(out, 'wordpress/acme-widgets/editor.js')]));
});

let playwright = null;
try { playwright = createRequire(join(repo, 'runtime/package.json'))('playwright'); } catch {}
test('in a browser: one script tag defines every component, and they work', { skip: !playwright && 'Playwright is installed with ../runtime' }, async () => {
  const server = createServer((request, response) => {
    const path = join(out, new URL(request.url, 'http://x').pathname);
    if (!existsSync(path)) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'text/html' });
    response.end(request.url === '/page.html'
      ? readFileSync(join(out, 'html/star-rating.html'), 'utf8') + '<greeting-card name="Ada"></greeting-card>\n<script type="module" src="./acme-widgets.js"></script>'
      : readFileSync(path));
  });
  writeFileSync(join(out, 'page.html'), '');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    await page.goto(`http://127.0.0.1:${server.address().port}/page.html`);
    await page.waitForFunction(() => customElements.get('star-rating') && customElements.get('greeting-card') && document.querySelector('name-badge b')?.textContent);
    assert.equal(await page.textContent('name-badge b'), 'Hello, Ada', 'a child component and a plain module from a subfolder');
    await page.click('star-rating button >> nth=3');
    assert.equal(await page.$eval('star-rating', (el) => el.value), 4);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
