// Lit: a LitElement app whose shadow root holds light-DOM zubra elements. Their scoped styles are
// adopted into that shadow root; .prop and @event bindings; repeat() keyed lists; and the
// signed-in user shared through the context protocol, provided by @lit/context and read by zubra's
// inject().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('lit-chat: a team chat built from zubra elements inside a Lit app', async () => {
  const { page, messages, url } = await launch('lit-chat');
  await page.goto(`${url}/?delay=300`);
  await page.waitForSelector('chat-message article');
  await settle(page);
  const go = async (selector) => { await page.click(selector); await settle(page); };
  const message = (n) => page.locator('chat-message').nth(n);
  const authors = () => texts(page, 'chat-message .author');

  // Styles reach into Lit's shadow root.
  assert.equal(await page.$eval('team-chat', (el) => !!el.shadowRoot), true);
  assert.equal(await message(0).locator('.avatar').evaluate((el) => getComputedStyle(el).borderRadius !== '0px'), true);
  assert.equal(await page.locator('typing-dots').evaluate((el) => getComputedStyle(el).display), 'block');

  // Context: the user from Lit's ContextProvider.
  assert.deepEqual(await authors(), ['Grace Hopper', 'Linus Torvalds', 'Ada Lovelace']);
  assert.equal(await message(2).locator('.you').count(), 1);
  assert.equal(await message(1).locator('article').evaluate((el) => el.classList.contains('mentioned')), true, '@Ada mentions Ada');
  await page.selectOption('select[aria-label="Signed in as"]', 'Grace Hopper');
  await settle(page);
  assert.equal(await message(2).locator('.you').count(), 0, 'every message follows the provider');
  assert.equal(await message(0).locator('.you').count(), 1);
  assert.equal(await message(1).locator('article').evaluate((el) => el.classList.contains('mentioned')), false);
  await page.selectOption('select[aria-label="Signed in as"]', 'Ada Lovelace');
  await settle(page);

  // Reactions: add one through the hover toolbar, toggle an existing one.
  await message(2).hover();
  await message(2).locator('button[aria-label="React 🎉"]').click();
  await settle(page);
  assert.deepEqual(await message(2).locator('.reactions button').evaluateAll((els) => els.map((el) => `${el.textContent.trim()}:${el.getAttribute('aria-pressed')}`)), ['🎉 1:true']);
  await message(0).locator('.reactions button').click();
  await settle(page);
  assert.equal(await message(0).locator('.reactions button').textContent(), '👍 2');
  assert.equal(await message(0).locator('.reactions button').getAttribute('title'), 'Linus Torvalds, Ada Lovelace');
  await message(0).locator('.reactions button').click();
  await settle(page);
  assert.equal(await message(0).locator('.reactions button').textContent(), '👍 1');

  // The composer: empty can't be sent; Shift+Enter is a new line; Enter sends.
  const field = page.locator('message-composer textarea');
  assert.equal(await page.locator('message-composer .send').isDisabled(), true);
  await field.fill('Two lines');
  await field.press('Shift+Enter');
  await field.pressSequentially('of text');
  await settle(page);
  assert.equal(await field.inputValue(), 'Two lines\nof text');
  // Record who shows as typing, however briefly.
  await page.evaluate(() => {
    window.typed = [];
    const dots = document.querySelector('team-chat').shadowRoot.querySelector('typing-dots');
    new MutationObserver(() => {
      const who = dots.querySelector('.who')?.textContent;
      if (who && !window.typed.includes(who)) window.typed.push(who);
    }).observe(dots, { subtree: true, childList: true, characterData: true });
  });
  await field.press('Enter');
  await settle(page);
  assert.equal(await field.inputValue(), '', 'sent and cleared');
  assert.equal(await message(3).locator('p').textContent(), 'Two lines\nof text');
  // Someone answers, typing first.
  await page.waitForFunction(() => document.querySelector('team-chat').shadowRoot.querySelectorAll('chat-message').length === 5);
  await settle(page);
  assert.deepEqual(await page.evaluate(() => window.typed), ['Grace Hopper is typing']);
  assert.equal(await message(4).locator('.author').textContent(), 'Grace Hopper');
  assert.equal(await message(4).locator('.quote').textContent(), 'Ada Lovelace: Two lines\nof text');
  assert.equal(await page.locator('typing-dots .who').count(), 0);

  // Replying: the composer shows what's quoted; Escape cancels; a mention picks who answers.
  await message(1).hover();
  await message(1).locator('button.reply').click();
  await settle(page);
  assert.match(await page.textContent('message-composer .reply'), /Replying to Linus Torvalds: The release branch is cut\./);
  await field.press('Escape');
  await settle(page);
  assert.equal(await page.locator('message-composer .reply').count(), 0);
  await message(1).hover();
  await message(1).locator('button.reply').click();
  await field.fill('Fixed it, @Linus please review');
  // The emoji menu inserts at the caret.
  await go('message-composer button.emoji');
  await go('message-composer .picker button:has-text("🚀")');
  assert.equal(await field.inputValue(), 'Fixed it, @Linus please review🚀');
  await field.press('Enter');
  await page.waitForFunction(() => document.querySelector('team-chat').shadowRoot.querySelectorAll('chat-message').length === 7);
  await settle(page);
  assert.equal(await message(5).locator('.quote').textContent(), 'Linus Torvalds: The release branch is cut. @Ada can you look at the flaky test?');
  assert.deepEqual(await message(5).locator('.mention').allTextContents(), ['@Linus']);
  assert.equal(await message(6).locator('.author').textContent(), 'Linus Torvalds');

  // Channels: opening one clears its unread count; each has its own messages.
  assert.equal(await page.textContent('nav [data-channel=design] .unread'), '2');
  await go('nav [data-channel=design]');
  assert.equal(await page.locator('nav [data-channel=design] .unread').count(), 0);
  assert.deepEqual(await authors(), ['Grace Hopper', 'Ada Lovelace']);
  assert.equal(await page.getAttribute('message-composer textarea', 'placeholder'), 'Message #design');
  await go('nav [data-channel=general]');
  assert.equal(await page.locator('chat-message').count(), 7);
  assert.deepEqual(messages, []);
  await page.close();
});
