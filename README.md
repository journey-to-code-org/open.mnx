# MNIX HTML-First Framework

MNIX is an experimental build-time component compiler. Rust parses `.mnx` source, validates it into an intermediate representation, and emits semantic HTML. A later release may add scoped CSS and a small Custom Element runtime that executes compiler-generated DOM operations. The compiler is native build tooling; it is not part of `portfolio-wasm` and is never shipped to the browser.

## v0.1.0: Static compiler foundation

The first release supports component metadata, required typed scalar props, one HTML-fragment template, and escaped interpolation. It intentionally has no browser runtime.

```text
component: Greeting
tag: mnix-greeting
prop name: string
prop profile: url
---
<article class="greeting">
  <h1>Hello, {{ name }}.</h1>
  <a href="{{ profile }}">View profile</a>
</article>
```

An optional valid hyphenated `tag` wraps the rendered root in that custom-element host; it does not imply that a runtime has been generated.

The static compiler supports required scalar prop types `string`, `number`, `boolean`, and `url`. v0.2 adds `strings`, a JSON array of strings intended for compile-time iteration. Extra values and values of the wrong declared type are rejected.

The template parser recognizes nested HTML elements, quoted attributes, boolean attributes, and HTML void elements. A component must have exactly one root element. Scripts, styles, inline `style` attributes, inline event-handler attributes, comments, doctypes, and unquoted attribute values are rejected. Dynamic values are escaped for HTML text/attribute contexts; authored static markup is preserved as written. Interpolating a boolean prop into a native boolean attribute adds or omits that attribute; the compiler rejects incompatible dynamic types. URL attributes accept safe literal URLs or a single prop declared `url`; URL props and static URL attributes reject unsafe schemes (including schemes obscured by HTML character references), protocol-relative URLs, and control characters. Static `srcset` candidates are checked individually; dynamic `srcset` and `srcdoc` interpolation are rejected because their URL-list and nested-HTML contexts need distinct contracts.

## v0.2.0: Static composition

MNIX now supports compile-time structure and slots. `@if` and `@each` are intentionally expressed as reserved HTML-like tags, not as runtime bindings:

```text
component: FeatureList
prop ready: boolean
prop mode: string
prop features: strings
---
<main>
  <mnix-if test='ready && mode == "active"'>
    <ul>
      <mnix-each items="features" as="feature">
        <li>{{ feature }}</li>
      </mnix-each>
    </ul>
    <mnix-else><p>Features are not available.</p></mnix-else>
  </mnix-if>
  <mnix-slot name="actions"><a href="/">Continue</a></mnix-slot>
</main>
```

`<mnix-if test="...">` accepts literals, prop or loop identifiers, `!`, `==`, `!=`, `&&`, `||`, and parentheses. Conditions must evaluate to booleans; both sides are validated even if a boolean operator could otherwise short-circuit. `<mnix-else>` is optional, unique, and the final non-whitespace child of its `<mnix-if>`.

`<mnix-each items="features" as="feature">` iterates over a declared `strings` prop. The item is a lexically scoped string identifier and can be interpolated or referenced by nested conditions. The compiler expands it before HTML rendering; no runtime list or directive element is emitted. Lists of other values and object/member access are not supported yet.

`<mnix-slot>` names the default slot; `name="actions"` declares a named slot. Missing slot content uses the slot's fallback children. Optional CLI `--slots slots.json` input is a JSON object mapping slot names to **MNIX template fragment strings**. Each fragment is parsed and validated through the same HTML/template pipeline; it is never copied as raw HTML. `mnix-slot`, `mnix-if`, `mnix-each`, and `mnix-else` are reserved compiler tags and are removed during static lowering.

The compiler pipeline parses source into an AST, validates props/references/structure while lowering into a static HTML IR, and renders deterministic HTML. Runtime descriptors, scoped CSS, browser bindings, state, and events remain future releases.

## Commands

Install Rust 1.82 or newer. The compiler is tested with Rust 1.93.0.

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo run --locked -- compile examples/greeting.mnx --props examples/greeting.props.json
cargo run --locked -- compile examples/feature-list.mnx --props examples/feature-list.props.json --slots examples/feature-list.slots.json
```

The compiler writes HTML to stdout by default. `--output <file>` writes to a file using atomic promotion. For example, append `--output target/greeting.html` to the final command to save the generated fragment.

## Release direction

- `0.1.0`: static parser, typed props, validated IR, escaping, diagnostics, CLI, tests.
- `0.2.0`: compile-time conditions, loops, and default/named slots (implemented).
- `0.3.0`: parsed/scoped CSS, deterministic artifact manifest, hashes, byte counts, atomic output, and freshness checking.
- `0.4.0`: light-DOM Custom Element upgrade and generated descriptors.
- `0.5.0`: typed local state and fine-grained DOM operations.
- `0.6.0` and later: standalone Workshop document, portfolio routing/build/PWA integration, and hardening.

The version list is the MNIX framework roadmap. This repository owns the generic parser, IR, validation, renderer, and CLI; portfolio-specific page content, visual theme, and routing will remain in the portfolio repository when a later release integrates MNIX as a submodule.
