// The browser half of an Enhance element, written for apps that create elements themselves.
// @enhance/element renders in its constructor, which `document.createElement` refuses ("The
// result must not have children"), and React and Angular create elements that way; it also has
// attributes and a store but no properties, and a framework passes arrays as properties. So this
// keeps Enhance's contract (a pure `render({ html, state })`, shared with @enhance/ssr, and
// morphdom to apply it) on a base that renders once connected and has a property per prop.
import BaseElement from '@enhance/base-element';
import morphdom from 'morphdom';

const styled = new Set();

export function define(tag, { render, props = {}, shadow = false, setup }) {
  class Element extends BaseElement {
    static observedAttributes = Object.keys(props);
    props = {};
    root = shadow ? this.attachShadow({ mode: 'open' }) : this;
    #ready = false;
    #queued = false;

    constructor() {
      super();
      for (const name of Object.keys(props)) {
        // A property set before the element was defined: take it over.
        const early = Object.hasOwn(this, name) ? this[name] : undefined;
        delete this[name];
        Object.defineProperty(this, name, {
          get: () => this.props[name] ?? props[name],
          set: (value) => {
            if (this.props[name] === value) return;
            this.props[name] = value;
            this.update();
          },
        });
        if (early !== undefined) this.props[name] = early;
      }
    }
    get state() {
      return { ...super.state, props: this.props };
    }
    connectedCallback() {
      if (this.#ready) return;
      this.#ready = true;
      this.process();
      setup?.(this);
    }
    attributeChangedCallback() {
      this.update();
    }
    /** Render once per task turn, however many props changed. */
    update() {
      if (!this.#ready || this.#queued) return;
      this.#queued = true;
      queueMicrotask(() => {
        this.#queued = false;
        this.process();
      });
    }
    process() {
      let markup = render({ html: this.html, state: this.state }).trim();
      if (!shadow) {
        // Light DOM: the element's <style> goes to the document once, as @enhance/ssr puts it in the head.
        markup = markup.replace(/<style>([\s\S]*?)<\/style>/g, (_, rules) => {
          if (!styled.has(tag)) {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(rules);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          }
          styled.add(tag);
          return '';
        });
      }
      const next = document.createElement('div');
      next.innerHTML = markup;
      morphdom(this.root, next, {
        childrenOnly: true,
        // `open` on a shown <dialog> is the browser's, not the template's: taking it off would
        // hide a modal dialog without closing it, and leave the page inert.
        onBeforeElUpdated: (from, to) => {
          if (from.nodeName === 'DIALOG' && from.open) to.setAttribute('open', '');
          return true;
        },
      });
      this.rendered?.();
    }
    emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
    }
  }
  if (!customElements.get(tag)) customElements.define(tag, Element);
  return Element;
}
