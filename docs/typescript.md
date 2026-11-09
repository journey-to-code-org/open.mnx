# TypeScript in `.zb` files

`<script lang="ts">` makes a component's script TypeScript. This page says exactly what the compiler does with the types, what it refuses and why, and what reaches the generated typings, so none of it is discovered as a compile error.

## The rule: types are removed, not compiled

The compiler reduces TypeScript to JavaScript by **blanking out the type syntax in place**: annotations, `type` and `interface` declarations, `import type`, `as`, `satisfies`, `!`, type arguments and type parameters are replaced by spaces of the same length, with line breaks kept. Every remaining token stays at its original line and column, so an error anywhere later in the pipeline points into the TypeScript you wrote.

This is the same subset Node's type stripping accepts and the same one TypeScript's `erasableSyntaxOnly` flag enforces: **syntax that would need JavaScript generated for it is not accepted.** The compiler never runs the TypeScript type checker, never resolves a type across files, and never emits code from a type.

What that buys: no `tsc` in the compile path, byte-identical output from the Rust CLI and the WebAssembly build, and source positions that are always right. What it costs is the list below.

## What is refused, and what to write instead

| Refused | Why | Write instead |
|---|---|---|
| `enum Color { Red, Green }` | An enum is a runtime object; erasing it would leave `Color.Red` undefined. | `const Color = { Red: "red", Green: "green" } as const` and `type Color = typeof Color[keyof typeof Color]` |
| `namespace N { … }` (unless `declare namespace`) | A namespace is a runtime object too. | An object, or a module |
| `class A { constructor(private x: number) {} }` | A parameter property is an assignment the compiler would have to write. | Declare the field and assign it in the constructor |
| `<T>value` | An angle-bracket assertion is ambiguous with JSX, and the parser is the same for `.zb.tsx`. | `value as T` |
| `import x = require("…")` | CommonJS; a component script is an ES module. | `import x from "…"` |
| `function f(this: Window) {}` | A `this` parameter is type-only, but its position isn't erasable in place. | Leave it off, or cast inside the function |

Each is an error at the construct, with the replacement in its help text. Everything else TypeScript's `erasableSyntaxOnly` accepts is accepted here: annotations everywhere, generics on functions and classes, `satisfies`, non-null `!`, optional and definite fields (`x?: T`, `x!: T`), overload signatures (removed), abstract classes and `declare` fields, `import type` and `export type`.

## What the types still do

The types aren't thrown away. Three things in the script carry their type text into the component's interface:

1. **An annotated binding used as a prop's default.** `const options: Option[] = []`, then `<my-select options={options}>`, declares `options` as `Option[]` in the typings and the manifest. Without the annotation the type would be inferred from the value (`[]` → `unknown[]`).
2. **`declare const name: Type`** types a prop whose default can't say enough, or a required prop (which otherwise is `unknown`): `declare const size: 'small' | 'large'`. A `declare const` that names no prop is an error.
3. **`emit<Detail>("name", detail)`** types the event: the typings get `CustomEvent<Detail>` where a plain `emit("name", variable)` would get `CustomEvent<unknown>` (a literal's shape is inferred: `emit("select", { id: 1 })` is `CustomEvent<{ id: number }>`).

The script's own `type` and `interface` declarations are **exported from the generated `.d.ts`**, with or without `export` written on them (`export interface`, `export type` and `export type { … }` are type-only, so the no-exports rule for component scripts doesn't apply to them), and its imports are **re-emitted as `import type`**, so a type the interface mentions resolves wherever the typings are used.

```html
<script lang="ts">
  import { emit } from '@zubra/runtime'
  import type { Option } from './types'
  export interface Picked { id: string; index: number }

  const optionsDefault: Option[] = []       // a prop's default takes another name: `options` is the prop
  declare const size: 'small' | 'large'

  function pick(index: number) {
    emit<Picked>('pick', { id: options[index].id, index })
  }
</script>
<my-select options={optionsDefault} size="small">…</my-select>
```

`zubra compile my-select.zb --emit dts` writes, among the rest:

```ts
import type { Option } from './types';
export interface Picked { id: string; index: number }

export declare class MySelect extends HTMLElement {
  options: Option[];
  size: 'small' | 'large';
  …
}
export interface MySelectEventMap extends HTMLElementEventMap { pick: CustomEvent<Picked>; }
export interface MySelectProps { options?: Option[]; size?: 'small' | 'large'; }
```

and `--emit manifest` records the same text (`"type": { "text": "Option[]" }`) for each prop and event.

The React and Vue wrappers `@zubra/unplugin` and `zubra build --lib` write are typed from the same interface, so `<MySelect options={…} onPick={(e) => e.detail.index} />` is checked in the consuming app by its own `tsc`.

## What this means for complex props

- **The type text is copied, not checked.** If `Option` has a typo, the component compiles and the consuming app's `tsc` reports it, because the `.d.ts` imports a type that doesn't exist. That is the right place for the error, since that's where the types are used, but it is later than you might expect.
- **Nothing is resolved across files.** The compiler knows `options` is `Option[]` because you wrote it; it does not know what `Option` contains. The manifest records the text `Option[]`. Tools that read the manifest (Storybook, editors) see the name and not the shape, which is also how they treat Lit's `@property({ type: Object })`.
- **Generics on a component don't cross the element boundary.** A custom element is one class registered under one tag; the DOM has no place for `<data-grid<Row>>`. Type the prop with the widest type it takes (`rows: Row[]`, or a union), and narrow in the consuming app. This is true of every web-component toolchain, not a Zubra limit, and it is the reason [What crosses the boundary](what-crosses-the-boundary.md) puts generic containers on the framework side.

## Where this sits against Lit and Stencil

Lit components are TypeScript files compiled by your own `tsc`, so every TypeScript feature works and the types of properties are whatever you declare, and with lit-analyzer its templates' bindings are checked against those types too, which Zubra's aren't; the cost is that the element's interface for *other* tools (manifest, React wrapper typings) needs a separate analyzer. Stencil runs the TypeScript compiler itself and generates framework packages with full types, at the cost of its compiler being a TypeScript program with the whole language service in it.

Zubra's position is the middle one: the compiler carries the type *text* through to the interface with no type checker in the path, and leaves checking to the `tsc` that already runs in the consuming app. The full comparison is in [Compared with Lit and Stencil](compared-with-lit-and-stencil.md).
