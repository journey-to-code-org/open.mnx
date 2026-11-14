// The browser's script for a server-rendered page: Lit's hydration support has to load before
// the elements, so they keep the server's markup instead of rendering again.
import '@lit-labs/ssr-client/lit-element-hydrate-support.js';
import './elements.js';
