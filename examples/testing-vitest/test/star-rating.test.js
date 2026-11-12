// One test, three consumers: the rating as plain HTML, through the React adapter and through the
// Vue adapter, the way apps on each would use it. `npm test` (Vitest browser mode, Chromium).
import { describe, expect, test } from 'vitest';
import { frameworks, mount } from '@zubra/runtime/testing';
import StarRating from '../components/star-rating.zb?element';

const found = await frameworks();

test('React and Vue are installed, so all three run', () => {
  expect(found).toEqual(['html', 'react', 'vue']);
});

describe.each(found)('%s', (framework) => {
  test('starts at the given value', async () => {
    const view = await mount(StarRating, { framework, props: { value: 2, max: 5 } });
    expect(view.element.value).toBe(2);
    expect(view.element.querySelector('[aria-pressed="true"]').getAttribute('aria-label')).toBe('2 of 5');
    view.unmount();
  });

  test('a click sets the value and reaches the framework as valuechange', async () => {
    const view = await mount(StarRating, { framework, props: { value: 1 } });
    const stars = view.element.querySelectorAll('button');
    stars[3].click();
    await view.set({});
    expect(view.element.value).toBe(4);
    expect(view.events('valuechange')).toEqual([4]);
    view.unmount();
  });

  test('a new value from the app reaches the element', async () => {
    const view = await mount(StarRating, { framework, props: { value: 1 } });
    await view.set({ value: 3 });
    expect(view.element.value).toBe(3);
    view.unmount();
  });

  test('readonly: a click changes nothing', async () => {
    const view = await mount(StarRating, { framework, props: { value: 1, readonly: true } });
    view.element.querySelectorAll('button')[4].click();
    await view.set({});
    expect(view.element.value).toBe(1);
    expect(view.events('valuechange')).toEqual([]);
    view.unmount();
  });
});
