# TypeScript in `.zb` files

`<script lang="ts">` makes a component's script TypeScript. This page says exactly what the compiler does with the types, what it refuses and why, and what reaches the generated typings, so none of it is discovered as a compile error.

## The rule: types are removed; what runs is written as TypeScript writes it

The compiler reduces TypeScript to JavaScript by **blanking out the type syntax in place**: annotations, `type` and `interface` declarations, `import type`, `as`, `satisfies`, `<T>value`, `!`, `this` parameters, type arguments and type parameters are replaced by spaces of the same length, with line breaks kept. Every remaining token stays at its original line and column, so an error anywhere later in the pipeline points into the TypeScript you wrote.

What has to run is written where it was, as TypeScript itself writes it, **with the same number of lines**, so every line after it keeps its number:

- an **`enum`** becomes an object (see [Enums](#enums));
- a **`namespace`** becomes TypeScript's function wrapper, `const N = {}; (function (N) { … })(N);`, with each exported member assigned to it, and references to an exported variable read through it (`N.x`), as `tsc` writes them. A namespace with only types writes nothing; one declared again, or after a function or class of the same name, adds to it; `namespace A.B.C` and exported nested namespaces work;
- a **parameter property** (`constructor(private x: number)`) becomes a field and an assignment at the top of the constructor, or right after `super(…)` in a subclass;
- **`import X = A.B`** becomes `const X = A.B` when it's read as a value (by the script or the template) or names a value a namespace exports, and nothing when it names a type;
- **`<T>value`** becomes `(value)`, so it means what it did after `return` and a line break, as an arrow's `{…}` body, or at the start of a statement.

Some code is **moved**: a field's value into the constructor (see [tsconfig.json](#tsconfigjson)), a decorator into its call. It's moved with every rewrite inside it, and onto one line, so the lines it leaves and joins keep their count: comments go, a statement that ended at a line break gets its `;`, and a line break inside a template literal is written `\n`. A tagged template over more than one line can't be moved that way (its tag sees the raw text), and is an error that says to write it on one line.

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
| `export const { a, b } = value` in a namespace | Not lowered yet (`tsc` lowers it). | `export const a = value.a, b = value.b` |

Each is an error at the construct, with the replacement in its help text. In a `.zb.tsx` file, `<T>value` is refused by the parser, as `tsc` refuses it in any `.tsx` file.

## tsconfig.json

A TypeScript component is compiled under its **nearest `tsconfig.json`** (following a relative `extends`; comments and trailing commas are fine). The CLI reads it from disk; `@zubra/compiler` sends it to the WebAssembly build with the component. Only the options that change what the JavaScript does are read:

| Option | What it changes |
|---|---|
| `useDefineForClassFields` (or a `target` below ES2022, which turns it off) | Off, fields are **assigned** in the constructor rather than defined, as `tsc` writes them: an instance field's initializer moves into the constructor after `super(…)` and the parameter properties (a constructor is written if there's none), a static one becomes `static { this.x = …; }`, a field with no initializer goes, and a parameter property is no field of its own. A `#private` instance field (and an `accessor`'s storage) is declared where it was and assigned in the constructor in order with the rest, as `tsc` writes it; a static `#private` field stays a field. With no tsconfig, or no `target`, fields are defined, as for a modern target. |
| `verbatimModuleSyntax` | Imports are kept as written, so a type imported without `type` is an error, as in `tsc` (TS1484), rather than dropped. |
| `paths` and `baseUrl` | A non-relative import (`@shared/sizes`) of a TypeScript module is found through them, for the enums in it. |
| `experimentalDecorators` | `@` means TypeScript's legacy decorators: see [Decorators](#decorators). |

Every other option leaves the output as it is: Zubra writes modern JavaScript for the browser whatever `target` says (it reads `target` only for the class-fields default), and `strict`, `lib` and the rest are for type checking. An `extends` that names a package isn't followed.

## Decorators

With **`experimentalDecorators`** on, decorators are TypeScript's legacy ones (what Lit, Angular and most decorator libraries were written for), written as `tsc` writes them: each `@decorator` goes from where it was, and `__decorate` calls follow the class on its last line, instance members first, then static ones, then the class with its constructor's parameter decorators. A class decorator wraps the class, `const A = (() => { var A = class { static { A = this; } … }; …; return A = __decorate([…], A); })();`, on the class's own lines, so the class's own references to `A` see what the decorator returns, as `tsc`'s `A_1` does. `export default` works, named or not. Legacy decorators on a class *expression* are refused, as TypeScript refuses them (TS1206; `tsc` writes nothing for them). TypeScript's two helpers are added to the script's first line when they're used. A plugin test runs a class with every kind of decorator through both the compiler and `tsc`. `emitDecoratorMetadata` isn't written.

**Standard decorators** (TC39's, TypeScript's default since 5.0) are lowered the way `tsc` lowers them for ES2022, since no browser runs them yet, with TypeScript's own helpers (`__esDecorate`, `__runInitializers`, `__setFunctionName`, `__propKey`) on the script's first line. The class is wrapped in a function that holds the decorators' bookkeeping, `const A = (() => { let _zb_d0, …; return class A { static { /* applies them */ } … }; })();`, and everything stays on the class's own lines, with each member's code where it was:

- a field's value runs through its decorators' initializers in place, and their extra initializers run right after it's defined (a private `#_zb_e0` field, or a static block, that follows it);
- a decorated `#private` method's function is created where it was, in the computed name of a throwaway static field that's deleted once the class is defined, and a getter of the same name returns what the decorators made of it;
- a class decorator replaces what the name holds, inside the class as well;
- decorators are evaluated in the order they're written, with any computed names among them, as `tsc` evaluates them.

`accessor x = 1` is lowered with or without decorators: a private `#x_accessor_storage` field, with a getter and a setter. Three plugin tests run classes with every kind of member decorator (methods, getters, setters, fields, accessors, `#private` ones, static ones, literal and computed names), class decorators that return a subclass, anonymous classes, the decorators' `access` and `addInitializer`, metadata, and fields assigned in the constructor, through both the compiler and `tsc --target es2022`, and compare what they do.

Refused, each with an error that says what to write: a parameter decorator without `experimentalDecorators` (standard decorators don't have them, TS1206), a decorator on a `declare` field, an abstract member or a constructor (TS1206), an `accessor` with a computed name, and, with `useDefineForClassFields` off, a decorated field with a computed name.

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

**`interface Props`** (or `type Props = { … }`) types every prop in one place, as Vue's and Svelte's components do:

```html
<script lang="ts">
  interface Props {
    size: 'small' | 'large'
    options?: Option[]
  }
</script>
<my-select size="small" options={[]}>…</my-select>
```

Each member types the prop of its name (in the typings, the manifest and the type check), and the two lists must match: a member with no prop on the host tag, or a prop the interface doesn't have, is an error naming it. The host still gives the defaults, and `zubra check --types` checks them against these types, a text default (`size="big"`) included; `declare const` keeps working beside it. A method member (`pick(item: Option): void`) types a function prop. When `Props` has members the script doesn't list (`interface Props extends Base`, or `type Props = Base & { … }`), a host prop it doesn't list is typed `Props["name"]`, for TypeScript to resolve.

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

## Checking types: `zubra check --types`

```sh
npx zubra check --types src
```

An app made with `npm create zubra@latest -- --typescript` has it as `npm run check`, with a `tsconfig.json` and TypeScript installed.

The project's own TypeScript checks its components: each script as written, **every template expression in its scope**, every child component's props against the child's types, and every event handler with its event typed. Errors land on the `.zb` lines they came from:

```text
src/inbox.zb:12:20 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
src/inbox.zb:13:59 - error TS2551: Property 'subjet' does not exist on type 'Message'. Did you mean 'subject'?
src/inbox.zb:14:37 - error TS2551: Property 'clientXX' does not exist on type 'PointerEvent'. Did you mean 'clientX'?
```

How it works, the way Vue's and Svelte's tooling work:

- The compiler writes each component as a TypeScript file (`zubra compile x.zb --emit tsx` shows it), with a map back to the component:
  - the props, as the script sees them (`declare let size: Size;`);
  - the script, as written;
  - the component's typings, so a `.ts` file that imports it sees its real types;
  - the template:
    - each `zb-each` is a `for…of`, so its item has the list's element type;
    - each `zb-if` is an `if`, so narrowing carries into the branch;
    - a `zb-then` value is the awaited type;
    - an `onclick` handler's `event` is a `MouseEvent`;
    - a child's `onpick` handler's event is the child's `CustomEvent<…>`;
    - a child's `count={…}` is checked against the child's `count`, and `open:bind={on}` both ways;
    - a `zb-switch`'s value is compared with each `zb-case`'s `is`;
    - a `<zb-window>` or `<zb-document>` listener's event is the window's or the document's (`onstorage` is a `StorageEvent`).
  - A signal the template reads is its value there, as the template unwraps it (a `Signal.State` or `Signal.Computed`; another object with a `get` method stays itself). A `const enum` is read as written.
  - A `zb-catch` error is `unknown`, as a `catch` variable is under `strict`: narrow it (`error instanceof Error`) before reading `.message`.
- Those files go in `.zubra-types/check/` at the project root (removed afterwards; `--keep` keeps them; the editor's checks each use a folder of their own beside it). A tsconfig there extends the project's and joins the two folders with `rootDirs`, so `./badge.zb` and `./types` resolve from either. A component imported from outside the project is mirrored inside the folder too.
- The map is in the compiler's UTF-8 bytes, and converted to the string positions `tsc` and editors count in, so an error after an emoji or an accented letter lands on the right column; `tsc` runs from the project's folder, so its paths are read right wherever you run the command from.
- The project's own `tsc` runs once (TypeScript is the project's, as with `vue-tsc`), and each error is moved back through the map.
- No type checker is in the compile path. Checking is this separate step, for CI and the editor.

**In VS Code**, the extension shows the same errors in a TypeScript component when it opens and each time it's saved, beside the compiler's own diagnostics (it uses the project's `@zubra/compiler` and `typescript`, in a process of its own). In a TypeScript component it also gives **hover, completion and go to definition from TypeScript**, in the script and in every `{…}` of the template, from TypeScript 5.9's language service, which it ships with (the native TypeScript 7 has no language service API yet), over the same file. Type errors come from the project's own TypeScript, when you save.

Only `<script lang="ts">` components are checked. A JavaScript component's file is there so the components that use it get its props' and events' types, and a `.zb.tsx` component's typings are there for the same reason (its own code is TypeScript, which `tsc` checks as it is, with your `jsx` settings). A required prop with no `declare const` is `unknown` to the checker, so give it a type. `--format json` gives each error as the Rust CLI's `check --format json` does, path relative to where it ran, with a `code` (`TS2322`).

Type errors in the editor are worked out when a file opens and when it's saved; while you type, the last ones stay where they were until the next save.

## What this means for complex props

- **The type text is copied, not checked.** If `Option` has a typo, the component compiles and the consuming app's `tsc` reports it, because the `.d.ts` imports a type that doesn't exist. That is the right place for the error, since that's where the types are used, but it is later than you might expect.
- **Nothing is resolved across files.** The compiler knows `options` is `Option[]` because you wrote it; it does not know what `Option` contains. The manifest records the text `Option[]`. Tools that read the manifest (Storybook, editors) see the name and not the shape, which is also how they treat Lit's `@property({ type: Object })`.
- **Generics on a component don't cross the element boundary.** A custom element is one class registered under one tag; the DOM has no place for `<data-grid<Row>>`. Type the prop with the widest type it takes (`rows: Row[]`, or a union), and narrow in the consuming app. This is true of every web-component toolchain, not a Zubra limit, and it is the reason [What crosses the boundary](what-crosses-the-boundary.md) puts generic containers on the framework side.

## Where this sits against Lit and Stencil

Lit components are TypeScript files compiled by your own `tsc`. With lit-analyzer, a template's bindings are checked against its properties' types, and the element's interface for other tools (manifest, React wrapper typings) needs a separate analyzer. Stencil runs the TypeScript compiler itself and generates framework packages with full types, at the cost of its compiler being a TypeScript program with the whole language service in it.

Zubra checks templates as lit-analyzer does, with `zubra check --types`, and generates the manifest and every framework's typings from the same interface. It does both with no TypeScript compiler in the build: the build blanks types and lowers what runs, and checking is the project's own `tsc`, run when you ask. The full comparison is in [Compared with Lit and Stencil](compared-with-lit-and-stencil.md).
