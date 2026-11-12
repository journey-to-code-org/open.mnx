# TypeScript in `.zb` files

`<script lang="ts">` makes a component's script TypeScript. This page says exactly what the compiler does with the types, what it refuses and why, and what reaches the generated typings, so none of it is discovered as a compile error.

## The rule: types are removed; what runs is written as TypeScript writes it

The compiler reduces TypeScript to JavaScript by **blanking out the type syntax in place**: annotations, `type` and `interface` declarations, `import type`, `as`, `satisfies`, `<T>value`, `!`, `this` parameters, type arguments and type parameters are replaced by spaces of the same length, with line breaks kept. Every remaining token stays at its original line and column, so an error anywhere later in the pipeline points into the TypeScript you wrote.

What has to run is written where it was, as TypeScript itself writes it, **with the same number of lines**, so every line after it keeps its number:

- an **`enum`** becomes an object (see [Enums](#enums));
- a **`namespace`** becomes TypeScript's function wrapper, `const N = {}; (function (N) { … })(N);`, with each exported member assigned to it, and references to an exported variable read through it (`N.x`), as `tsc` writes them. A namespace with only types writes nothing; one declared again, or after a function or class of the same name, adds to it; `namespace A.B.C` and exported nested namespaces work;
- a **parameter property** (`constructor(private x: number)`) becomes a field and an assignment at the top of the constructor, or right after `super(…)` in a subclass;
- **`import X = A.B`** becomes `const X = A.B` when it's read as a value, and nothing when it names a type.

A plugin test compiles each of these with both the compiler and `tsc` and checks they do the same thing. The compiler never runs the TypeScript type checker and never emits code from a type.

**Imports used only as types go too**, as TypeScript, esbuild and Babel drop them: `import { Option } from './types'` with `Option` used only in annotations leaves the module, so the browser never asks `./types` for a name it doesn't export at runtime. A name the host or the template reads (`{Size.Large}`) is kept, and so is an import the script never mentions (the template may use it, or it's there for its side effects). Writing `import type` says it outright, and is still the clearest.

What that buys: no `tsc` in the compile path, byte-identical output from the Rust CLI and the WebAssembly build, and source positions that are always right.

## What is refused

Only what TypeScript itself refuses in an ES module, and a component script is one:

| Refused | Why | Write instead |
|---|---|---|
| `import x = require("…")` | CommonJS; `tsc` refuses it in an ES module too (TS1202). | `import x from "…"` |
| `export = value` | CommonJS (TS1203). | A component script exports nothing: props go on the host tag |
| `export namespace N { … }` | A component's exports are its interface; only `export enum` belongs there. | Drop `export` (the namespace works inside the component), or move it to a module |

Each is an error at the construct, with the replacement in its help text. In a `.zb.tsx` file, `<T>value` is refused by the parser, as `tsc` refuses it in any `.tsx` file.

## tsconfig.json

A TypeScript component is compiled under its **nearest `tsconfig.json`** (following a relative `extends`; comments and trailing commas are fine). The CLI reads it from disk; `@zubra/compiler` sends it to the WebAssembly build with the component. Only the options that change what the JavaScript does are read:

| Option | What it changes |
|---|---|
| `useDefineForClassFields` (or a `target` below ES2022, which turns it off) | Off, fields are **assigned** in the constructor rather than defined, as `tsc` writes them: an instance field's initializer moves into the constructor after `super(…)` and the parameter properties (a constructor is written if there's none), a static one becomes `static { this.x = …; }`, a field with no initializer goes, and a parameter property is no field of its own. `#private` fields stay fields. With no tsconfig, or no `target`, fields are defined, as for a modern target. |
| `verbatimModuleSyntax` | Imports are kept as written, so a type imported without `type` is an error, as in `tsc` (TS1484), rather than dropped. |
| `paths` and `baseUrl` | A non-relative import (`@shared/sizes`) of a TypeScript module is found through them, for the enums in it. |
| `experimentalDecorators` | `@` means TypeScript's legacy decorators: see [Decorators](#decorators). |

Every other option leaves the output as it is: Zubra writes modern JavaScript for the browser whatever `target` says (it reads `target` only for the class-fields default), and `strict`, `lib` and the rest are for type checking. An `extends` that names a package isn't followed.

## Decorators

With **`experimentalDecorators`** on, decorators are TypeScript's legacy ones (what Lit, Angular and most decorator libraries were written for), written as `tsc` writes them: each `@decorator` goes from where it was, and `__decorate` calls follow the class on its last line, instance members first, then static ones, then the class with its constructor's parameter decorators. A class decorator wraps the class, `const A = ((A) => { …; return __decorate([…], A); })(class A { … });`, on the class's own lines. TypeScript's two helpers are added to the script's first line when they're used. A plugin test runs a class with every kind of decorator through both the compiler and `tsc`. `emitDecoratorMetadata` isn't written.

**Standard decorators** (the TC39 proposal, TypeScript's default) are an error for now: no browser runs them yet, so the compiler would have to lower them, and it doesn't yet. The error says how to use legacy decorators instead.

## Enums

An `enum` is lowered where it's written. When every member is a constant (the usual case), it's an object literal, a numeric member with its reverse mapping as TypeScript gives it:

```ts
enum Size {            const Size = {
  Small,                 Small: 0, "0": "Small",
  Large = 4,             Large: 4, "4": "Large",
}                      };
```

A member computed at runtime (`A = "abc".length`), or a second declaration of the same enum, is written as TypeScript's own statements (`Size[Size["A"] = "abc".length] = "A";`). Either way the lowering has **as many lines as the declaration**, so every line after it keeps its number; only columns inside the enum differ. Member values are worked out as TypeScript works them out: auto-increment, constant arithmetic, bitwise and string expressions, template strings without substitutions, references to earlier members by bare name or through another enum (`Other.A`). `declare enum` declares nothing at runtime. A `const enum` declared in the script is kept as an object too, since the template may read it. A test compiles each kind with both the compiler and `tsc` and checks they do the same thing.

### An enum as a prop's type

```html
<script lang="ts">
  export enum Size { Small, Medium = 4, Large }
  declare const size: Size
</script>
<my-box size={Size.Medium}>…</my-box>
```

- **`export enum`** makes the enum part of the component's interface. It's the one value a component script exports: the element module exports `Size` (`export const Size = { … };`, created once for the module, so an exported enum's members must be constants), the typings declare `export declare enum Size { … }`, and the React and Vue wrappers re-export it: `import MyBox, { Size } from './my-box.zb?react'`.
- A default of `Size.Medium` types the prop as `Size` on its own; `declare const size: Size` says it outright.
- A prop typed with an enum the component **doesn't** export can't be given a value by name. With a string member that's an error (TypeScript accepts no string where the enum is expected); with only numbers it's a warning.
- **Attributes take a member's value or its name.** `size="5"` and `size="Large"` both set the property to `5`; for a string enum, `tone="cool"` (and `tone="Cool"`). Anything else keeps the default, with a warning listing the members. Server rendering and `--props` read the same forms. The property itself is always the enum's value.
- The manifest records the enum as a variable of the module, with its values, and the prop's type points at it; `--emit html-data` lists the members, so the editor offers them on the attribute.

### Enums from other modules

`import { Size } from './sizes'` from a relative TypeScript module (`./sizes.ts`, `./sizes.js` meaning `./sizes.ts`, `./sizes/index.ts`, re-exports followed): the compiler reads the module for the enum's values, so attributes, defaults and the manifest know them as above.

A **`const enum`** needs more: TypeScript erases it, so the module that declares it may export nothing by that name at runtime, and the import would fail in the browser. The compiler inlines it instead: the import goes, and the component's module gets its own copy of the values, `const Size = { Small: 1, Large: 4 };`. If a member isn't a constant the compiler can work out, that's an **error** at the import, in every compile path and in the editor, since the output wouldn't load; the fix is a regular `enum`, or a literal value.

Imports from packages aren't followed: a package's enum stays imported, which works when the package ships it at runtime.

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
