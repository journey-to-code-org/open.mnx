// mnx elements in a zoneless Angular app, compiled JIT and bundled with esbuild: property and event
// bindings, @if/@for content in light-DOM slots, and the MnxModel form control (ngModel, reactive
// forms, disabled, touched). `npm run test:browser`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { useBrowser, open, here, site } from './harness.js';

useBrowser({
  rating: join(here, 'fixtures/rating.mnx'),
  card: join(here, 'fixtures/card.mnx'),
  badge: join(here, 'fixtures/badge.mnx'),
});

const src = join(here, '../../src');

const APP = `
import '@angular/compiler';
import { Component, CUSTOM_ELEMENTS_SCHEMA, signal, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { FormsModule, ReactiveFormsModule, FormControl } from '@angular/forms';
import { MnxModel } from '${src}/angular.js';
import '/rating.js';
import '/card.js';
import '/badge.js';

window.log = [];

class App {
  stars = 1;
  heading = signal('Hi');
  items = signal(['a']);
  title = signal(true);
  info = signal({ color: 'red' });
  control = new FormControl(1);
  constructor() { window.app = this; }
  changed(event) { window.log.push(['valuechange', event.detail]); }
  committed() { window.log.push(['change']); }
}
Component({
  selector: 'app-root',
  imports: [FormsModule, ReactiveFormsModule, MnxModel],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: \`
    <mnx-rating id="model" mnxModel [(ngModel)]="stars" (valuechange)="changed($event)" (change)="committed()"></mnx-rating>
    <p id="stars">{{ stars }}</p>
    <mnx-rating id="reactive" mnxModel [formControl]="control"></mnx-rating>
    <p id="control">{{ control.value }}</p>
    <mnx-card [heading]="heading()">
      @if (title()) { <h2 slot="title">Custom</h2> }
      @for (item of items(); track item) { <p>{{ item }}</p> }
    </mnx-card>
    <mnx-badge label="x" [info]="info()"></mnx-badge>
  \`,
})(App);

window.appRef = await bootstrapApplication(App, { providers: [provideZonelessChangeDetection()] });
window.tick = async () => { window.appRef.tick(); await new Promise((resolve) => setTimeout(resolve)); };
`;

const pageModules = {
  name: 'page-modules',
  setup(builder) {
    builder.onResolve({ filter: /^\/[a-z-]+\.js$/ }, (args) => ({ path: args.path, external: true }));
  },
};

before(async () => {
  const entry = join(site, 'angular.entry.js');
  writeFileSync(entry, APP);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile: join(site, 'angular.js'), target: 'es2022',
    plugins: [pageModules], logLevel: 'error', nodePaths: [join(here, '../../node_modules')],
  });
});

const settle = (page) => page.evaluate(async () => {
  await window.tick();
  await Promise.all([...document.querySelectorAll('mnx-rating, mnx-card, mnx-badge')].map((el) => el.updateComplete));
});

const read = (page) => page.evaluate(() => {
  const strip = (html) => html.replace(/<!--.*?-->/g, '').replace(/ _ng\w+(-\w+)*=""/g, '').trim();
  const card = document.querySelector('mnx-card');
  return {
    model: document.querySelector('#model output').textContent,
    stars: document.getElementById('stars').textContent,
    reactive: document.querySelector('#reactive output').textContent,
    control: document.getElementById('control').textContent,
    header: strip(card.querySelector('header').innerHTML),
    section: strip(card.querySelector('section').innerHTML),
    footer: card.querySelector('footer').textContent,
    color: document.querySelector('mnx-badge .badge').dataset.color,
  };
});

test('angular: bindings, slots and the MnxModel form control', async () => {
  const { page, messages } = await open('<app-root></app-root>', { modules: ['angular'] });
  await page.waitForFunction(() => window.appRef);
  await settle(page);
  assert.deepEqual(await read(page), {
    model: '1', stars: '1', reactive: '1', control: '1', header: '<h2 slot="title">Custom</h2>', section: '<p>a</p>',
    footer: 'Hi footer', color: 'red',
  });

  await page.click('#model .two');
  await settle(page);
  assert.deepEqual(await page.evaluate(() => window.log), [['valuechange', 2], ['change']]);
  assert.equal((await read(page)).stars, '2', 'ngModel took the new value');

  await page.click('#reactive .two');
  await settle(page);
  assert.equal((await read(page)).control, '2', 'the FormControl took the new value');
  assert.equal(await page.evaluate(() => [window.app.control.dirty, window.app.control.touched].join()), 'true,false');
  await page.focus('#reactive .note');
  await page.focus('#model .note');
  assert.equal(await page.evaluate(() => window.app.control.touched), true, 'leaving the element marks it touched');

  await page.evaluate(() => { window.app.control.setValue(1); window.app.control.disable(); });
  await settle(page);
  assert.equal((await read(page)).reactive, '1', 'setValue() reaches the element');
  assert.equal(await page.$eval('#reactive', (el) => el.hasAttribute('disabled')), true, 'disable() reaches the element');
  await page.evaluate(() => { window.app.control.enable(); window.app.control.reset(); });
  await settle(page);
  assert.equal((await read(page)).reactive, '0', 'reset() (null) is the component default');
  assert.equal(await page.$eval('#reactive', (el) => el.hasAttribute('disabled')), false);

  await page.evaluate(() => { window.app.items.set(['c', 'a', 'b']); });
  await settle(page);
  assert.equal((await read(page)).section, '<p>c</p><p>a</p><p>b</p>');
  await page.evaluate(() => { window.app.items.set(['b']); window.app.title.set(false); window.app.heading.set('New'); });
  await settle(page);
  assert.deepEqual(await read(page), {
    model: '2', stars: '2', reactive: '0', control: '', header: '<h2>New</h2>', section: '<p>b</p>', footer: 'New footer', color: 'red',
  }, 'an emptied slot shows its fallback');
  await page.evaluate(() => { window.app.items.set([]); window.app.title.set(true); window.app.info.set({ color: 'blue' }); });
  await settle(page);
  const after = await read(page);
  assert.deepEqual([after.header, after.section, after.color], ['<h2 slot="title">Custom</h2>', '<p>No content</p>', 'blue']);

  await page.evaluate(() => window.appRef.destroy());
  assert.equal(await page.$('mnx-card'), null);
  assert.deepEqual(messages.filter((message) => !/development mode/i.test(message)), []);
  await page.close();
});
