// The documentation's navigation: each group is a heading in the sidebar, and `file` is a path from the
// repository root. A page's address is its `slug`, or its path under docs/ without .md. The pages
// themselves are rendered by docs.js; demos/test/docs.test.js reads this list too.
export default [
  { group: 'Guide', pages: [
    { file: 'docs/guide/README.md', slug: '', label: 'Overview' },
    { file: 'docs/guide/01-first-component.md', label: 'Your first component' },
    { file: 'docs/guide/02-templates.md', label: 'Templates' },
    { file: 'docs/guide/03-props-and-events.md', label: 'Two-way props and events' },
    { file: 'docs/guide/04-composition.md', label: 'Composition and slots' },
    { file: 'docs/guide/05-forms.md', label: 'Forms' },
    { file: 'docs/guide/06-async-data.md', label: 'Async data' },
    { file: 'docs/guide/07-server-rendering.md', label: 'Server rendering' },
    { file: 'docs/guide/08-read-the-output.md', label: 'Read the output' },
  ] },
  { group: 'Coming from a framework', pages: [
    { file: 'docs/guide/for-react-developers.md', label: 'React developers' },
    { file: 'docs/guide/for-vue-developers.md', label: 'Vue developers' },
    { file: 'docs/guide/for-svelte-developers.md', label: 'Svelte developers' },
  ] },
  { group: 'Topics', pages: [
    { file: 'docs/who-this-is-for.md', label: 'Who Zubra is for' },
    { file: 'docs/what-crosses-the-boundary.md', label: 'What crosses the boundary' },
    { file: 'docs/server-rendering.md', label: 'Server rendering, honestly' },
    { file: 'docs/guide/other-peoples-pages.md', label: 'On other people’s pages' },
    { file: 'docs/guide/accessible-widgets.md', label: 'Accessible widgets' },
    { file: 'docs/guide/styling-libraries.md', label: 'Styling libraries' },
  ] },
  { group: 'Reference', pages: [
    { file: 'README.md', slug: 'reference', label: 'Reference (the README)' },
    { file: 'docs/browser-support.md', label: 'Browser support' },
    { file: 'docs/security.md', label: 'Security model' },
    { file: 'docs/framework-matrix.md', label: 'The framework matrix' },
    { file: 'docs/convert-measured.md', label: '`zubra convert`, measured' },
    { file: 'CHANGELOG.md', slug: 'changelog', label: 'Changelog' },
  ] },
  { group: 'Migrating', pages: [
    { file: 'docs/migrating-to-5.0.md', label: 'To 5.0' },
    { file: 'docs/migrating-to-4.0.md', label: 'To 4.0 (mnx is now Zubra)' },
    { file: 'docs/migrating-to-3.0.md', label: 'To 3.0' },
    { file: 'docs/migrating-to-2.0.md', label: 'To 2.0' },
    { file: 'docs/migrating-from-0.2.md', label: 'From 0.2' },
  ] },
  { group: 'Standards reports', pages: [
    { file: 'docs/standards/declarative-custom-elements.md', label: 'Declarative custom elements' },
    { file: 'docs/standards/dom-parts.md', label: 'DOM Parts' },
    { file: 'docs/standards/signals.md', label: 'Signals' },
    { file: 'docs/standards/one-source-n-consumers.md', label: 'One source, N consumers' },
  ] },
];
