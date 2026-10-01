# MNIX HTML-First Framework

MNIX is an experimental build-time component compiler. Rust parses `.mnx` source, validates it into an intermediate representation, and emits semantic HTML. A later release may add scoped CSS and a small Custom Element runtime that executes compiler-generated DOM operations. The compiler is native build tooling; it is not part of `portfolio-wasm` and is never shipped to the browser.

## v0.1.0: Static compiler foundation

The first release supports component metadata, required typed scalar props, one HTML-fragment template, and escaped interpolation. It intentionally has no browser runtime yet.

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

Supported prop types are `string`, `number`, `boolean`, and `url`. Every declared prop is required, and extra values are rejected. Interpolation is a single declared prop identifier; expressions, compile-time structure, slots, styles, and runtime bindings are not implemented in v0.1. An optional valid hyphenated `tag` wraps the rendered root in that custom-element host; it does not imply that a runtime has been generated.

The template parser recognizes nested HTML elements, quoted attributes, boolean attributes, and HTML void elements. A component must have exactly one root element. Scripts, styles, inline `style` attributes, inline event-handler attributes, comments, doctypes, and unquoted attribute values are rejected. Dynamic values are escaped for HTML text/attribute contexts; authored static markup is preserved as written. Interpolating a boolean prop into a native boolean attribute adds or omits that attribute; the compiler rejects incompatible dynamic types. URL attributes accept safe literal URLs or a single prop declared `url`; URL props and static URL attributes reject unsafe schemes (including schemes obscured by HTML character references), protocol-relative URLs, and control characters. Static `srcset` candidates are checked individually; dynamic `srcset` and `srcdoc` interpolation are rejected because their URL-list and nested-HTML contexts need distinct contracts.

The compiler pipeline is source/header parsing, HTML-like template parsing into an AST, semantic validation and prop resolution into an IR, then deterministic HTML rendering. This separation is the foundation for later releases to add compile-time composition, scoped CSS, binding dependency graphs, and a generated browser descriptor without teaching the runtime `.mnx` syntax.

## Commands

Install Rust 1.82 or newer. The compiler is tested with Rust 1.93.0.

```sh
cargo test --locked
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo run --locked -- compile examples/greeting.mnx --props examples/greeting.props.json
```

The compiler writes HTML to stdout by default. `--output <file>` writes to a file using atomic promotion. For example, append `--output target/greeting.html` to the final command to save the generated fragment.

## Release direction

- `0.1.0`: static parser, typed props, validated IR, escaping, diagnostics, CLI, tests.
- `0.2.0`: compile-time conditions, loops, and default/named slots.
- `0.3.0`: parsed/scoped CSS, deterministic artifact manifest, hashes, byte counts, atomic output, and freshness checking.
- `0.4.0`: light-DOM Custom Element upgrade and generated descriptors.
- `0.5.0`: typed local state and fine-grained DOM operations.
- `0.6.0` and later: standalone Workshop document, portfolio routing/build/PWA integration, and hardening.

The version list is the MNIX framework roadmap. This repository owns the generic parser, IR, validation, renderer, and CLI; portfolio-specific page content, visual theme, and routing will remain in the portfolio repository when a later release integrates MNIX as a submodule.
