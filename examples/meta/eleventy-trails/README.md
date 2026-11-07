# Mountain trails: Eleventy

A static trail guide built with [Eleventy](https://www.11ty.dev). Its mnx components are
rendered to HTML **at build time** by a shortcode:

```njk
{% mnx "trail-card", { name: trail.name, href: trail.url, km: trail.km, mi: trail.mi } %}
```

They're hydrated in the browser with no bundler. The browser gets:
- the HTML;
- each component compiled to an ES module;
- `@mnx/runtime`, through an import map.

```sh
cargo build                 # from the repository root (the compiler, until @mnx/compiler is on npm)
cd examples/meta/eleventy-trails
npm install
npm start                   # http://localhost:8080
```

`eleventy.config.js` has the whole integration, in about 50 lines:
- **the shortcode**, which also records which components each page used;
- **a transform**, which puts those components' CSS in the page's `<head>` and imports their
  modules at the end of its body;
- **an `eleventy.after` step**, which writes `_site/components/*.js` and copies the runtime to
  `_site/vendor/mnx/`.

Without JavaScript, the list, every trail's facts and its elevation profile are all in the HTML.
With JavaScript, a filter appears (difficulty and length), and the units switch between km and
miles on every card. The choice is remembered.

## What it found

- **HTML minifiers remove the hydration markers.** mnx's markers are comments. A minifier with
  `removeComments: true` removes them, and the elements then render afresh instead of hydrating:
  - the result is correct;
  - each element logs a warning;
  - in-place hydration is lost.

  html-minifier-terser's `ignoreCustomComments: [/^[[\]?!]*$/]` keeps them, and nothing else.
  `MINIFY=1 npm run build` does that, and the tests build it both ways. This is the second
  example to lose markers, after htmx (`examples/hypermedia/`).
- **Precomputed data, again.** The elevation profile's SVG points, both units, and the climb in
  feet are worked out in `_data/trails.js` or with `%` arithmetic. The build-time renderer
  evaluates arithmetic, not `.map()`, `Math.round()` or `toFixed()`. Eleventy runs in Node.js,
  so rendering with JavaScript (roadmap challenge 1) would remove all of it.
- **The filter needs JavaScript, so it only renders once live** (the `live` pattern, a fourth
  time).
