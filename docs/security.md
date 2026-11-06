# Security model

mnx draws one trust boundary: **the `.mnx` source is code you trust; the values flowing into it are data you don't.** Props, attribute values, slot content supplied at build time, and values your script computes at runtime are all treated as untrusted. The rules below are enforced identically by the HTML output (at build time) and by the runtime (in the browser), so a component that is safe when server-rendered is safe when it updates.

## What the compiler and runtime guarantee

**Text is text.** Every `{expr}` in text is escaped in the HTML output and written with `textContent` (or a text node's `data`) at runtime, never parsed as HTML. There is no "raw HTML" binding.

**Attribute values are values.** Dynamic attribute values are escaped in the HTML output and written with `setAttribute` at runtime. An object or array can't be written to an attribute; it's reported and the attribute is removed. (Objects reach custom elements as properties instead.)

**URLs are checked.** For URL attributes (`href`, `src`, `action`, `formaction`, `poster`, `cite`, `background`, `codebase`, `data`, `longdesc`, `manifest`, `profile`, `usemap`, `xlink:href`), the final value must be relative or use `http:`, `https:`, `mailto:` or `tel:`. In the HTML output the check decodes HTML character references first, so `jav&#x61;script:` doesn't get through (at runtime, `setAttribute` never decodes them). Protocol-relative URLs (`//host`) and values with control characters are rejected too. Literal URLs are checked at build time everywhere; computed URLs are checked on their final value, at build time for the HTML output and on every update at runtime, where an unsafe value is reported and the attribute removed. Static `srcset` candidates are checked one by one; dynamic `srcset` and any interpolation into `srcdoc` are compile errors, because their URL-list and nested-document contexts need their own rules.

**Boolean attributes take booleans.** `disabled={x}` requires a boolean; a quoted interpolation into a boolean attribute is a compile error, so `"false"` can't silently mean true.

**No string event handlers.** `onclick="…"` is a compile error. `onclick={handler}` binds a function from the script, read when the event fires; it's left out of the HTML output.

**No inline styles or scripts in templates.** `style` attributes, `<style>` and `<script>` elements inside a template are compile errors. The component's own `<script>` block, before the host tag, is the only code in a component.

**Attributes are parsed, never evaluated.** A prop set from an attribute is parsed by its default's type: a number, a boolean, or `JSON.parse` for arrays and objects. Invalid JSON keeps the default and logs a warning.

**Build-time expressions can't run code.** The expression language in templates and build-time `const`s has no calls, assignment, `new` or `this`, so compiling a component never executes its expressions as JavaScript.

## What is your responsibility

- **The script is your code.** It runs with the page's privileges, as any module does. Treat a `.mnx` file like a `.js` file in code review and dependency choices.
- **Slot content is the caller's markup.** Content passed into a component's slots (children in HTML, a framework's children, `--slots` fragments at build time) is the caller's own DOM. mnx moves it into place and doesn't sanitize it. `--slots` fragments are parsed and validated by the compiler like templates, never pasted in as raw HTML.
- **`innerHTML` on a host behaves as on any element.** Setting `element.innerHTML` on an mnx element routes the parsed nodes into its slots, with exactly the platform's semantics for parsing that string. Don't pass it untrusted HTML, as with any element.
- **Context is visible to descendants.** `provide` answers any element inside the provider that asks for that context key, including other libraries' elements, as the Context Protocol intends. Don't use context to pass secrets to specific elements.
- **Third-party custom elements** that a template uses receive the values you bind (as properties once defined). What they do with them is up to them.

## Reporting a vulnerability

Please report security issues privately, through the repository's GitHub security advisories ("Report a vulnerability"), rather than in a public issue.
