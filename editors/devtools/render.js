// What the pane shows, as HTML, from what `__ZUBRA_DEVTOOLS__.inspect($0)` returned (see
// runtime/src/devtools.js for the shape). A pure function, so it's tested without a browser.

export const VERSION = 1;

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fileName = (file) => String(file).split(/[\\/]/).pop();

/** A source location: a button that opens the editor there, or plain text without a file. */
function where(file, at, label = null) {
  if (!at) return '<span class="where none" title="Compile with --devtools (Vite\'s dev server does) for source lines">no line</span>';
  const text = label ?? `${file ? `${fileName(file)}:` : 'line '}${at.line}`;
  if (!file) return `<span class="where">${escape(text)}</span>`;
  return `<button type="button" class="where" data-file="${escape(file)}" data-line="${at.line}" data-column="${at.column}" title="Open ${escape(file)}:${at.line}:${at.column} in the editor">${escape(text)}</button>`;
}

function values(title, list, empty) {
  const rows = list.length
    ? list.map(({ name, value }) => `<div class="row"><dt>${escape(name)}</dt><dd><code>${escape(value)}</code></dd></div>`).join('')
    : `<p class="quiet">${escape(empty)}</p>`;
  return `<section><h2>${escape(title)}</h2><dl>${rows}</dl></section>`;
}

function bindings(list, file) {
  return `<ul class="bindings">${list.map((binding) => `<li class="${binding.ranLast ? 'ran' : ''}">
  <div class="op"><code>${escape(binding.operation)}</code>${binding.ranLast ? '<span class="badge" title="Re-ran in the last update">ran</span>' : ''}</div>
  <div class="meta"><span class="target">${escape(binding.target)}</span> ${where(file, binding.at, binding.at ? `line ${binding.at.line}` : null)}</div>
  ${binding.dependsOn.length ? `<div class="reads">reads ${binding.dependsOn.map((name) => `<code>${escape(name)}</code>`).join(', ')}</div>` : ''}
</li>`).join('')}</ul>`;
}

/** The pane's content for one reading. */
export function render(result) {
  if (!result || result.missing) {
    return `<p class="note">No Zubra development runtime on this page.</p>
<p class="quiet">Run the app with Vite's dev server and <code>@zubra/unplugin</code>, which compiles components for this pane. A production build has no hook, by design.</p>`;
  }
  if (result.error) return `<p class="note">Couldn't read the page: ${escape(result.error)}</p>`;
  if (result.loading) return '<p class="quiet">Connecting…</p>';
  if (result.version !== VERSION) {
    return `<p class="note">This page's runtime speaks DevTools version ${escape(result.version)}; this extension reads version ${VERSION}. Update whichever is older.</p>`;
  }
  if (!result.component) {
    return '<p class="quiet">Not inside a Zubra component. Select an element a <code>.zb</code> component renders, or its host.</p>';
  }
  const { component } = result;
  const file = component.file;
  const here = result.bindings.filter((binding) => binding.here);
  const rest = result.bindings.filter((binding) => !binding.here);
  const update = result.lastUpdate;
  return `<header>
  <h1><code>&lt;${escape(component.tag)}&gt;</code></h1>
  ${file ? where(file, component.at, `${fileName(file)}:${component.at?.line ?? 1}`) : '<span class="where none" title="Compile with --devtools (Vite\'s dev server does) for its file and lines">not located</span>'}
</header>
<p class="quiet small">Signals: ${result.native ? 'native <code>Signal</code>' : 'polyfill'}${update.number ? ` · update ${update.number}: ${update.written.length ? `wrote ${update.written.map((name) => `<code>${escape(name)}</code>`).join(', ')}` : 'no named writes'}, ${update.ran} of this component's bindings re-ran` : ''}</p>
${values('Props', result.props, 'No props.')}
${values('State', result.state, component.located ? 'No state.' : 'Names need a --devtools build.')}
${here.length ? `<section><h2>On this node</h2>${bindings(here, file)}</section>` : ''}
${result.setBy ? `<section><h2>Set by <code>&lt;${escape(result.setBy.tag)}&gt;</code></h2>${bindings(result.setBy.bindings, result.setBy.file)}</section>` : ''}
<section><details${here.length ? '' : ' open'}><summary><h2>All bindings (${rest.length + here.length})</h2></summary>${bindings(rest, file)}</details></section>`;
}
