# 4. Composition and slots

## Components using components

Import a component and use its tag:

```html
<script>
  import './user-avatar.mnx'

  let people = [{ id: 1, name: "Ada", online: true }]
</script>
<people-list>
  <mnx-each items={people} as="person" key={person.id}>
    <user-avatar name={person.name} online={person.online}></user-avatar>
  </mnx-each>
</people-list>
```

The compiler knows the child's props, so a typo (`nmae={…}`), a wrong type or a missing required prop is an error at build time, in the parent's file. Values go in as properties, so objects and arrays arrive as they are.

## Slots

Content placed inside an element goes to its slots:

```html
<!-- info-card.mnx -->
<script>
  import { hasSlot } from '@mnx/runtime'

  const hasFooter = hasSlot('footer')
</script>
<info-card heading="">
  <h3>{heading}</h3>
  <mnx-slot><p>Nothing here yet.</p></mnx-slot>
  <mnx-if test={hasFooter}>
    <footer><mnx-slot name="footer"></mnx-slot></footer>
  </mnx-if>
</info-card>
```

```html
<info-card heading="Plans">
  <p>Three plans, billed monthly.</p>
  <a slot="footer" href="/pricing">Compare plans</a>
</info-card>
```

- `<mnx-slot>` is the default slot; `<mnx-slot name="footer">` takes children with `slot="footer"`. A slot's own content is its fallback, shown while nothing is given.
- `hasSlot(name)` says whether content was given, and follows it as content comes and goes. Use it to leave out markup that only makes sense around a used slot.
- Slotted content stays live: when React or Vue update the children they passed, the slot follows.

## Light DOM or shadow DOM

Components render into **light DOM** by default: their markup is part of the page, scoped styles keep their CSS to themselves, and page-level CSS (and Tailwind) still reaches in. Add `shadow` to the host tag for a shadow root: full style isolation, and native `<slot>`s.

## Sharing state between components

`createContext`, `provide` and `inject` pass a value down the tree without props, following the community Context Protocol (so they also work with Lit's context). For app-wide state, a module that exports `state()` signals works too: every component that reads one updates when it changes.

## Ready-made components, and publishing your own

`npx mnx add modal-dialog` copies a component from the registry into your project: twenty accessible components, from form controls to charts and a dialog. When yours are ready to share, `npx mnx build --lib src/components` makes them a package that works in every framework (the README's "Sharing components" section).

**Next:** [Forms](05-forms.md)
