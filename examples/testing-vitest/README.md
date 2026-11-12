# Testing a component library through every framework

A component's tests, written once and run three ways: as plain HTML, through the React adapter and through the Vue adapter, as apps on each would use it. Vitest's browser mode runs them in Chromium.

```js
import { frameworks, mount } from '@zubra/runtime/testing';
import StarRating from '../components/star-rating.zb?element';

describe.each(await frameworks())('%s', (framework) => {
  test('a click sets the value and reaches the framework as valuechange', async () => {
    const view = await mount(StarRating, { framework, props: { value: 1 } });
    view.element.querySelectorAll('button')[3].click();
    expect(view.events('valuechange')).toEqual([4]);
    view.unmount();
  });
});
```

`mount()` puts the component in the page through the framework's own adapter: props are set the framework's way, events reach the framework's handlers (`events(name)` lists their `detail`s), slots are its children, `set()` re-renders with new props, and a `<prop>change` event updates the prop as a two-way binding would. `frameworks()` lists the ones installed (plain HTML always).

```sh
npm install
npm test
```
