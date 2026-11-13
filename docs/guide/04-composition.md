# 4. Composition and slots

## Components using components

Import a component and use its tag:

```html
<script>
  import './user-avatar.zb'

  let people = [{ id: 1, name: "Ada", online: true }]
</script>
<people-list>
  <zb-each items={people} as="person" key={person.id}>
    <user-avatar name={person.name} online={person.online}></user-avatar>
  </zb-each>
</people-list>
```

The compiler knows the child's props, so a typo (`nmae={…}`), a wrong type or a missing required prop is an error at build time, in the parent's file. Values go in as properties, so objects and arrays arrive as they are.

## Slots

Content placed inside an element goes to its slots:

```html
<!-- info-card.zb -->
<script>
  import { hasSlot } from '@zubra/runtime'

  const hasFooter = hasSlot('footer')
</script>
<info-card heading="">
  <h3>{heading}</h3>
  <zb-slot><p>Nothing here yet.</p></zb-slot>
  <zb-if test={hasFooter}>
    <footer><zb-slot name="footer"></zb-slot></footer>
  </zb-if>
</info-card>
```

```html
<info-card heading="Plans">
  <p>Three plans, billed monthly.</p>
  <a slot="footer" href="/pricing">Compare plans</a>
</info-card>
```

- `<zb-slot>` is the default slot; `<zb-slot name="footer">` takes children with `slot="footer"`. A slot's own content is its fallback, shown while nothing is given.
- `hasSlot(name)` says whether content was given, and follows it as content comes and goes. Use it to leave out markup that only makes sense around a used slot.
- Slotted content stays live: when React or Vue update the children they passed, the slot follows.

## Light DOM or shadow DOM

Components render into **light DOM** by default: their markup is part of the page, scoped styles keep their CSS to themselves, and page-level CSS (and Tailwind) still reaches in. Add `shadow` to the host tag for a shadow root: full style isolation, and native `<slot>`s.

## Sharing state between components

`createContext`, `provide` and `inject` pass a value down the tree without props, following the community Context Protocol (so they also work with Lit's context). For app-wide state, a module that exports `state()` signals works too: every component that reads one updates when it changes.

## Components from a package

A component can import another from an installed package, by the package's name:

```html
<script>
  import '@acme/kit/components/cart-panel.zb'
</script>
<shop-page>
  <cart-panel title="Your cart"></cart-panel>
</shop-page>
```

It's looked for as Node looks for a package, in the `node_modules` of the file's folder and each folder above it. A package with `exports` must export its components (`"./components/*": "./components/*"`); a package without one exposes every file. The package's component is checked like any child, so a wrong prop is an error in your file, and its own relative imports work as they do in yours. A missing package, or a file the package doesn't export, is an error that says which.

The CLI, `@zubra/compiler`, the Vite plugin and the language server all follow this. On a server, tell `@zubra/server` which folders hold a package's components, so it can serve their modules and render them by name or tag:

```js
const zubra = createZubra({ components: 'src/components', packages: ['@acme/kit/components'] });
```

Each folder adds one import map entry, sending `@acme/kit/components/` to the server's component route. Your component and a package's with one tag (both carrying a copy of a shared part, an `action-button` say): yours wins. Rendering by the tag or by the package's name gives yours, the package's own components use yours too (in server HTML they still render the package's copy inside them, so keep the copies the same), and the browser defines the tag once. If the two sources differ, comments aside, the server warns once. Two of your components, or two packages', with one tag is an error that names both. The edge entry, `zubra build` and the manifest don't read packages yet.

## Ready-made components, and publishing your own

`npx zubra add modal-dialog` copies a component from the registry into your project: twenty-six accessible components, from form controls and charts to tabs, menus and a dialog. When yours are ready to share, `npx zubra build --lib src/components` makes them a package that works in every framework (the README's "Sharing components" section).

**Next:** [Forms](05-forms.md)
