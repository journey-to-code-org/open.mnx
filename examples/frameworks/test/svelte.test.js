// Svelte 5: mnx elements used directly, props as properties and on<name> events, a shadow-DOM
// element with named slots filled from Svelte markup, keyed re-creation with {#key}, and a
// component that listens on the document (1–4 keys) and cleans up when removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, settle, texts } from './harness.js';

test('svelte-flashcards: a spaced-repetition trainer built from mnx elements', async () => {
  const { page, messages } = await launch('svelte-flashcards');
  await page.waitForSelector('flip-card');
  await settle(page);
  const go = async (selector) => { await page.click(selector); await settle(page); };
  const front = () => page.textContent('flip-card .front-text');

  assert.equal(await front(), 'la biblioteca');
  assert.equal(await page.textContent('.remaining'), '8 to go');
  assert.equal(await page.$eval('flip-card', (el) => !!el.shadowRoot), true, 'a shadow-DOM component');
  // Grading is off until the card is flipped.
  assert.equal(await page.$eval('grade-buttons button', (el) => el.disabled), true);
  await page.keyboard.press('3');
  await settle(page);
  assert.equal(await front(), 'la biblioteca', 'keys do nothing before flipping');

  // Flip with a click; the back face (a named slot) shows; grade Good.
  await go('flip-card');
  assert.equal(await page.$eval('flip-card', (el) => el.flipped), true);
  assert.equal(await page.$eval('flip-card', (el) => el.shadowRoot.querySelector('.card').classList.contains('flipped')), true);
  assert.equal(await page.textContent('.tip'), 'How well did you know it? (1–4)');
  await go('grade-buttons button.good');
  assert.equal(await front(), 'el desayuno');
  assert.equal(await page.$eval('flip-card', (el) => el.flipped), false, 'the next card starts face up');
  // Keyboard: Space flips (the card is focusable), 4 = Easy, 1 = Again (back of the queue).
  await page.focus('flip-card .card');
  await page.keyboard.press('Space');
  await settle(page);
  assert.equal(await page.$eval('flip-card', (el) => el.flipped), true);
  await page.keyboard.press('4');
  await settle(page);
  assert.equal(await front(), 'despacio');
  await go('flip-card');
  await page.keyboard.press('1');
  await settle(page);
  assert.equal(await front(), 'la cuenta');
  assert.equal(await page.textContent('.remaining'), '6 to go', 'Again keeps the card in the session');

  // The sidebar follows: boxes and the mastered ring (Easy moved a card to box 3).
  assert.deepEqual(await texts(page, '.boxes b'), ['6', '1', '1', '0', '0']);
  assert.equal(await page.textContent('.mastered'), '0/8');
  assert.deepEqual(await texts(page, 'nav small'), ['6 due', '6 due', '4 due']);

  // Finish the deck: Good on everything; the card graded Again comes round again.
  for (let i = 0; i < 6; i++) {
    await go('flip-card');
    await go('grade-buttons button.good');
  }
  assert.equal(await page.textContent('.done h3'), 'Session complete');
  assert.equal(await page.textContent('.tally'), 'Again 1 · Hard 0 · Good 7 · Easy 1');
  assert.deepEqual(await texts(page, 'nav small'), ['0 due', '6 due', '4 due']);
  assert.deepEqual(await texts(page, '.boxes b'), ['0', '7', '1', '0', '0']);

  // Review everything anyway; Easy twice takes a card to box 4 ("mastered").
  await go('button.cram');
  assert.equal(await page.textContent('.remaining'), '8 to go · reviewing everything');
  await go('flip-card');
  await go('grade-buttons button.easy');
  assert.equal(await page.textContent('.mastered'), '1/8');
  assert.equal(await page.$eval('progress-ring svg', (el) => el.getAttribute('aria-label')), 'Mastered: 13%');

  // Another deck: a new session.
  await go('nav button[data-deck=capitals]');
  assert.equal(await front(), 'Australia');
  assert.equal(await page.textContent('.remaining'), '6 to go');

  // Managing cards.
  await go('[role=tab]:has-text("Cards")');
  await page.fill('input[aria-label=Front]', 'Chile');
  await page.fill('input[aria-label=Back]', 'Santiago');
  await go('form.add button[type=submit]');
  assert.deepEqual((await texts(page, 'tbody td:first-child')).slice(-2), ['Vietnam', 'Chile']);
  await go('button[aria-label="Delete Kenya"]');
  assert.equal(await page.textContent('[role=tab]:has-text("Cards")'), 'Cards (6)');
  await go('[role=tab]:has-text("Study")');
  assert.equal(await page.textContent('.remaining'), '5 to go', 'the deleted card left the session (a new one joins the next)');

  // Progress is saved.
  await page.reload();
  await page.waitForSelector('nav button');
  await settle(page);
  assert.deepEqual(await texts(page, 'nav small'), ['0 due', '6 due', '4 due']);
  assert.equal(await page.textContent('.mastered'), '1/8');
  assert.deepEqual(messages, []);
  await page.close();
});
