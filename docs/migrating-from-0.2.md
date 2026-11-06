# Migrating from 0.2

0.3 replaced the 0.2 header-and-template format with single-file components. 1.0 keeps that format. The compiler rejects every 0.2 form with an error saying what to write instead, so a 0.2 component fails loudly rather than compiling differently.

## Side by side

0.2:

```text
component: FeatureList
tag: mnix-feature-list
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

1.0:

```html
<script>
  const features = ["Static HTML", "Scoped slots", "Escaped output"]
</script>
<mnx-feature-list ready={true} mode="active" features={features}>
  <main>
    <mnx-if test={ready && mode == "active"}>
      <ul>
        <mnx-each items={features} as="feature">
          <li>{feature}</li>
        </mnx-each>
      </ul>
      <mnx-else><p>Features are not available.</p></mnx-else>
    </mnx-if>
    <mnx-slot name="actions"><a href="/">Continue</a></mnx-slot>
  </main>
</mnx-feature-list>
```

## Changes

| 0.2 | 1.0 | What the compiler says |
|---|---|---|
| `component:` / `tag:` / `prop …` / `---` header | The host tag is the component: `<mnx-feature-list …>…</mnx-feature-list>` wraps the template | "the `component:`/`prop`/`---` header is v0.2 syntax; declare the component with its host tag instead" |
| `prop name: string` (required) | A bare attribute on the host: `<mnx-x name>` | |
| typed props without defaults | Defaults on the host; the type comes from the default: `count={0}`, `label="Hi"`, `items={[]}`, `open={false}` | |
| `prop profile: url` | A string prop; URL safety now applies to every URL attribute's final value, whatever its source | |
| `prop features: strings` | Any array: `features={["a", "b"]}`, including arrays of objects | |
| `{{ name }}` | `{name}`, and any expression: `{user.name ?? "anonymous"}` | "`{{ … }}` is v0.2 syntax; v0.3 uses single braces" |
| `test='ready && mode == "active"'` (quoted) | `test={ready && mode == "active"}`. Expressions follow JavaScript's rules: truthiness, `==` is strict, `?.` `??` `? :` and arithmetic work | "`test` on <mnx-if> is an expression: write test={…}" |
| `items="features"` | `items={features}`, with optional `index="i"` and `key={item.id}` | |
| `<mnix-if>` `<mnix-else>` `<mnix-each>` `<mnix-slot>` | `<mnx-if>` `<mnx-else>` `<mnx-each>` `<mnx-slot>` | "<mnix-if> was renamed to <mnx-if> in v0.3" |
| `mnix-` custom element prefix | `mnx-` (any valid custom element name works) | |
| exactly one root element | Any number of top-level nodes: the host is the root | |
| props come only from `--props` | Defaults come from the component; `--props` overrides them | |

## What stays the same

- `--props props.json` and `--slots slots.json` on the CLI, for the HTML output.
- Slots: `<mnx-slot>` is the default slot, `name="…"` a named slot, children are the fallback.
- Escaping and URL rules (now also applied at runtime; see `security.md`).
- `--output <file>` with atomic writes.

## What's new

Everything a 0.2 component can do in HTML it can now also do as a live custom element (`--emit js`): reactive state, events, hydration of the server-rendered HTML, slots, components using components, forms and context. See the README.
