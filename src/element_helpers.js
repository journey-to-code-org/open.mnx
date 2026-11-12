// The helpers `--emit element` writes into a component's module, each only when the component
// needs it. A section starts with `//@@ name: dependencies`; `class:` sections go inside the
// element's class. `@name` is a module-level name the compiler picks (the name itself, or a
// `$`-prefixed one when the component already uses it), and `@@styled`/`@@slots` are filled in.

//@@ bind:
/** Keeps one spot in the DOM up to date: `write` runs when `read` gives a value it hasn't had. */
function @bind(read, write) {
  let last = @bind; // nothing written yet
  return () => {
    const value = read();
    if (Object.is(value, last)) return;
    const previous = last === @bind ? undefined : last;
    write((last = value), previous);
  };
}

//@@ attribute:
/** An attribute from a value: null, undefined and false remove it. */
function @attribute(node, name, value) {
  if (value == null || value === false) {
    node.removeAttribute(name);
  } else if (typeof value === "object") {
    console.error(`zubra: cannot write an object to the "${name}" attribute`, value);
    node.removeAttribute(name);
  } else {
    node.setAttribute(name, value);
  }
}

//@@ isSafeUrl:
/** The rule the compiler checks at build time: http(s), mailto and tel URLs, and relative ones. */
function @isSafeUrl(value) {
  const url = String(value).trim();
  if (!url || /[\u0000-\u001f\u007f-\u009f]/.test(url) || url.startsWith("//")) return false;
  const beforePath = url.split(/[/?#]/)[0];
  const colon = beforePath.indexOf(":");
  return colon < 0 || ["http", "https", "mailto", "tel"].includes(beforePath.slice(0, colon).toLowerCase());
}

//@@ isSafeSrcset: isSafeUrl
/** Every URL in a srcset is safe. */
function @isSafeSrcset(value) {
  const urls = String(value).split(",").map((candidate) => candidate.trim().split(/\s+/)[0]).filter(Boolean);
  return urls.length > 0 && urls.every(@isSafeUrl);
}

//@@ urlAttribute: attribute
/** A URL attribute (href, src…), written only when `safe` says the URL is safe. */
function @urlAttribute(node, name, value, safe) {
  if (value != null && value !== false && typeof value !== "object") {
    const text = String(value);
    if (text.trim() === "") return node.removeAttribute(name);
    if (!safe(text)) {
      console.error(`zubra: blocked an unsafe URL in "${name}":`, text);
      return node.removeAttribute(name);
    }
  }
  @attribute(node, name, value);
}

//@@ setValue:
/**
 * A form field's value: the property (what's shown and submitted), not the attribute (which is
 * only its starting value).
 */
function @setValue(node, value) {
  const text = String(value ?? "");
  if (node.value !== text) node.value = text;
  // A <select>'s options may come from a list inside it that renders after this: again once they're there.
  if (node.localName === "select" && node.value !== text) queueMicrotask(() => { if (node.value !== text) node.value = text; });
}

//@@ setStyle:
/** One CSS property from a value: null, false and "" remove it. */
function @setStyle(node, property, value) {
  if (value == null || value === false || value === "") node.style.removeProperty(property);
  else node.style.setProperty(property, String(value));
}

//@@ swapClasses:
/** A computed class next to class: toggles: its tokens come and go one by one, so the toggled classes stay. */
function @swapClasses(node, previous, next) {
  const tokens = (value) => String(value ?? "").split(/\s+/).filter(Boolean);
  const after = tokens(next);
  for (const token of tokens(previous)) if (!after.includes(token)) node.classList.remove(token);
  for (const token of after) node.classList.add(token);
}

//@@ setProperty: attribute
// Another library's custom element gets its property when it has one (React 19's rule). Until it's
// defined: an attribute (JSON for objects), and the property once it is. The latest value for each
// waits here, held weakly, so an element that's never defined keeps nothing alive.
const @waiting = new WeakMap(); // node → { prop: value }
const @waitingTags = new Map(); // tag → Set of WeakRef(node)
function @setProperty(node, prop, name, value) {
  if (prop in node) {
    node[prop] = value;
    return;
  }
  if (!customElements.get(node.localName)) {
    let props = @waiting.get(node);
    if (!props) {
      @waiting.set(node, (props = {}));
      let nodes = @waitingTags.get(node.localName);
      if (!nodes) {
        const tag = node.localName;
        @waitingTags.set(tag, (nodes = new Set()));
        customElements.whenDefined(tag).then(() => {
          @waitingTags.delete(tag);
          for (const ref of nodes) {
            const later = ref.deref();
            const given = later && @waiting.get(later);
            if (given) for (const key in given) if (key in later) later[key] = given[key];
          }
        });
      }
      nodes.add(new WeakRef(node));
    }
    props[prop] = value;
  }
  if (value != null && typeof value === "object") node.setAttribute(name, JSON.stringify(value));
  else @attribute(node, name, value);
}

//@@ insert:
/** Puts a node in place (the platform's insertBefore, not one an element overrides for its slots). */
function @insert(parent, node, before) {
  return Node.prototype.insertBefore.call(parent, node, before);
}

//@@ move: insert
/** Moves a node already on the page, keeping its focus and state where the browser can (moveBefore). */
function @move(parent, node, before) {
  try {
    if (Element.prototype.moveBefore && node.isConnected && parent.isConnected) return parent.moveBefore(node, before);
  } catch {
    // not movable in one step: insert it
  }
  return @insert(parent, node, before);
}

//@@ list: insert move
/**
 * <zb-each>: a row per item, between two markers. Rows are matched by key, so a row that stays
 * keeps its nodes (and its focus), and moves only when it's out of order. `create(item, index)`
 * makes a row: its nodes, and how to bring them up to date. With `animate`, `leave` and `glide`
 * come too: removed rows leave, and the rows that stay glide to their new places.
 */
function @list(start, end, read, key, create, leave, glide) {
  let rows = new Map();
  const nodesOf = (row) => {
    const nodes = [];
    for (let node = row.first; node; node = node.nextSibling) {
      nodes.push(node);
      if (node === row.last) break;
    }
    return nodes;
  };
  // The node after `node`, passing rows on their way out.
  const after = (node) => {
    let next = node.nextSibling;
    while (next?.nodeType === 1 && next.hasAttribute("data-leaving")) next = next.nextSibling;
    return next;
  };
  const update = () => {
    const parent = start.parentNode;
    const items = [...(read() ?? [])];
    const ids = items.map((item, index) => key(item, index));
    const seen = new Set();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        console.error("zubra: duplicate zb-each key", id, `(row ${index + 1}); that row is not keyed`);
        ids[index] = Symbol("duplicate");
      }
      seen.add(ids[index]);
    });
    for (const [id, row] of rows) {
      if (seen.has(id)) continue;
      if (leave) leave(nodesOf(row), true);
      else for (const node of nodesOf(row)) node.remove();
    }
    const next = new Map();
    let last = start;
    items.forEach((item, index) => {
      const id = ids[index];
      let row = rows.get(id);
      if (!row) {
        const { nodes, update } = create(item, index);
        // A row is everything from its first node to its last, with what a list inside it adds later.
        row = { first: nodes.firstChild, last: nodes.lastChild, update };
        update(item, index); // filled in before it's on the page
        @insert(parent, nodes, after(last));
      }
      next.set(id, row);
      row.update(item, index);
      if (row.first !== after(last)) {
        const before = after(last);
        for (const node of nodesOf(row)) @move(parent, node, before);
      }
      last = row.last;
    });
    rows = next;
  };
  if (!glide) return update;
  const elements = () => [...rows.values()].flatMap((row) => nodesOf(row).filter((node) => node.nodeType === 1));
  return () => glide(elements(), update);
}

//@@ when: insert
/**
 * <zb-if>: the branch whose condition holds, between two markers, rebuilt only when that changes.
 * With `animate`, `leave` comes too: the branch going away leaves, beside the one replacing it.
 */
function @when(start, end, read, branches, leaving, leave) {
  let shown = -1;
  let update = null;
  return () => {
    const index = read() ? 0 : 1;
    if (index !== shown) {
      shown = index;
      leaving?.(start, end); // slotted content inside goes back to wait, not away
      if (leave && start.nextSibling !== end) {
        const nodes = [];
        for (let node = start.nextSibling; node !== end; node = node.nextSibling) nodes.push(node);
        nodes[nodes.length - 1].after(start); // the region starts after them now
        leave(nodes);
      }
      while (start.nextSibling !== end) start.nextSibling.remove();
      update = null;
      if (branches[index]) {
        const branch = branches[index]();
        branch.update(); // filled in before it's on the page
        @insert(end.parentNode, branch.nodes, end);
        update = branch.update;
      }
    }
    update?.();
  };
}

//@@ leave:
/**
 * Lets nodes finish their exit before they go. Each element gets `data-leaving` (and `inert`), so
 * CSS can transition or animate it out, and is removed once those animations end; with nothing
 * animating, or under prefers-reduced-motion, it goes at once. `float` takes the elements out of
 * the flow first, held where they are, so what's around them can move into their space.
 */
function @leave(nodes, float) {
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const elements = [];
  for (const node of nodes) {
    if (node.nodeType === 1 && !reduced && node.isConnected) elements.push(node);
    else node.remove();
  }
  // Every position first: floating one element moves the next.
  const places = elements.map((element) => float && {
    position: "absolute",
    top: `${element.offsetTop}px`,
    left: `${element.offsetLeft}px`,
    width: `${element.getBoundingClientRect().width}px`,
    height: `${element.getBoundingClientRect().height}px`,
    margin: "0",
  });
  elements.forEach((element, index) => {
    if (float) Object.assign(element.style, places[index]);
    element.inert = true;
    element.setAttribute("data-leaving", "");
  });
  for (const element of elements) {
    // getAnimations() brings styles up to date, so it sees what data-leaving started. An infinite
    // animation (a spinner inside) never ends, so it isn't waited for.
    const running = (element.getAnimations?.({ subtree: true }) ?? [])
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity && animation.playState !== "finished");
    if (!running.length) element.remove();
    else Promise.allSettled(running.map((animation) => animation.finished)).then(() => element.remove());
  }
}

//@@ glide:
/**
 * Runs `change`, then animates each element from where it was to where it is now (First, Last,
 * Invert, Play). Each element's `--zb-move-duration` (250ms) and `--zb-move-easing` say how;
 * a duration of 0, or prefers-reduced-motion, moves them without animating.
 */
function @glide(elements, change) {
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return change();
  const before = new Map(elements.map((element) => [element, element.getBoundingClientRect()]));
  change();
  for (const [element, was] of before) {
    if (!element.isConnected) continue;
    const now = element.getBoundingClientRect();
    const x = was.left - now.left;
    const y = was.top - now.top;
    if (!x && !y) continue;
    if (element.hasAttribute("data-leaving")) {
      // Held where it was on screen as it leaves, even if its container moved.
      element.style.top = `${parseFloat(element.style.top) + y}px`;
      element.style.left = `${parseFloat(element.style.left) + x}px`;
      continue;
    }
    const style = getComputedStyle(element);
    const time = /^\s*([\d.]+)(ms|s)\s*$/.exec(style.getPropertyValue("--zb-move-duration"));
    const duration = time ? Number(time[1]) * (time[2] === "s" ? 1000 : 1) : 250;
    if (!duration) continue;
    // "add": on top of the element's own transform.
    element.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], {
      duration,
      easing: style.getPropertyValue("--zb-move-easing").trim() || "cubic-bezier(0.2, 0, 0, 1)",
      composite: "add",
    });
  }
}

//@@ clone:
/** Markup, parsed once into a <template>; each call returns a fresh copy of its nodes. */
const @templates = new Map();
function @clone(markup) {
  let template = @templates.get(markup);
  if (!template) {
    template = document.createElement("template");
    template.innerHTML = markup;
    @templates.set(markup, template);
  }
  return template.content.cloneNode(true);
}

//@@ cloneSvg:
/** Markup that goes inside an <svg>: parsed there, so its elements are SVG elements. */
const @svgTemplates = new Map();
function @cloneSvg(markup) {
  let template = @svgTemplates.get(markup);
  if (!template) {
    template = document.createElement("template");
    template.innerHTML = `<svg>${markup}</svg>`;
    template.content.replaceChildren(...template.content.firstChild.childNodes);
    @svgTemplates.set(markup, template);
  }
  return template.content.cloneNode(true);
}

//@@ fromJson:
/** An attribute that holds JSON (how arrays and objects are written as attributes), or `fallback`. */
function @fromJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

//@@ fromEnum:
/**
 * An attribute for an enum prop: the member whose value it is (`"4"`, `"large"`), or the member
 * it names (`"Large"`). Anything else keeps `fallback`, with a warning listing the members.
 */
function @fromEnum(raw, members, fallback, attribute) {
  const values = Object.values(members);
  const found = values.find((value) => String(value) === raw);
  if (found !== undefined) return found;
  if (Object.hasOwn(members, raw)) return members[raw];
  console.warn(`zubra: attribute "${attribute}" is "${raw}", not one of ${Object.keys(members).join(", ")}`);
  return fallback;
}

//@@ reads:
// While a computed() or an effect runs: what it reads. Each entry reads the same value again, so
// it can tell later whether anything it depends on has changed.
let @reads = null;

//@@ createState: reads
/**
 * State: a value that updates the element when it's set, or (an array or plain object) changed
 * in place: push, splice and nested writes count. `.value` reads and sets it; so do `.get()` and
 * `.set()`.
 */
function @createState(initial, changed) {
  let version = 0;
  const proxies = new WeakMap(); // this state's own, so the same object in two states tells each
  const bump = () => {
    version++;
    changed();
  };
  const deep = (value) => {
    if (!value || typeof value !== "object" || !(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) return value;
    let proxy = proxies.get(value);
    if (!proxy) {
      proxy = new Proxy(value, {
        get: (target, key, receiver) => deep(Reflect.get(target, key, receiver)),
        set: (target, key, next, receiver) => {
          const same = Object.is(target[key], next);
          const done = Reflect.set(target, key, next, receiver);
          if (!same) bump();
          return done;
        },
        deleteProperty: (target, key) => {
          const done = Reflect.deleteProperty(target, key);
          bump();
          return done;
        },
      });
      proxies.set(value, proxy);
    }
    return proxy;
  };
  let value = deep(initial);
  const read = () => version;
  return {
    get value() {
      @reads?.push(read);
      return value;
    },
    set value(next) {
      if (Object.is(next, value)) return;
      value = deep(next);
      bump();
    },
    get() {
      return this.value;
    },
    set(next) {
      this.value = next;
    },
  };
}

//@@ createComputed: reads
/** A value derived from props and state, cached until something it read changes. */
function @createComputed(compute) {
  let seen = null; // [read again, the value it gave]
  let value;
  return {
    get value() {
      if (!seen || !seen.every(([read, last]) => Object.is(read(), last))) {
        const outer = @reads;
        const collected = (@reads = []);
        try {
          value = compute();
        } finally {
          @reads = outer;
          seen = collected.map((read) => [read, read()]);
        }
      }
      if (@reads) for (const [read] of seen) @reads.push(read); // what reads this depends on what it read
      return value;
    },
    get() {
      return this.value;
    },
  };
}

//@@ live:
/** A value that's read fresh each time (what hasSlot() and hydrated() give). */
function @live(read) {
  return {
    get value() {
      return read();
    },
    get() {
      return read();
    },
  };
}

//@@ ids:
let @ids = 0; // for id(): unique on the page

//@@ apple:
// .mod is ⌘ on Apple platforms and Ctrl elsewhere.
const @apple = /mac|iphone|ipad|ipod/i.test(globalThis.navigator?.platform ?? "");

//@@ slotted: insert
// Light-DOM slots: the page's children for this element, sorted by their slot attribute.
const @isContent = (node) => node.nodeType === 1 || (node.nodeType === 3 && node.data.trim() !== "");
const @slotName = (node) => (node.nodeType === 1 && node.getAttribute("slot")) || "default";

/**
 * The slot for each child: by its slot attribute. A framework's markers (comments, whitespace, a
 * pair of empty text nodes) go with the content they belong to.
 */
function @assignSlots(nodes) {
  const named = nodes.map((node) => (@isContent(node) ? @slotName(node) : null));
  const near = (i, step) => {
    for (let j = i + step; nodes[j]; j += step) if (named[j]) return named[j];
    return null;
  };
  const open = [];
  nodes.forEach((node, i) => {
    if (node.nodeType !== 3 || node.data) return;
    if (!open.length || (named[i + 1] && nodes[i + 1].data == null)) return open.push(i);
    const start = open.pop();
    named[start] = named[i] = named.slice(start + 1, i).find(Boolean);
  });
  return nodes.map((node, i) => named[i] ?? (node.nodeType === 8 ? near(i, 1) ?? near(i, -1) : near(i, -1) ?? near(i, 1)) ?? "default");
}

//@@ class:slots: slotted move
  // ---- slots
  // Light DOM has no <slot>, so this element places the page's children itself: each slot's
  // nodes, in order, between its two markers, or the fallback while it has none. Until a slot is
  // shown (or while it's in a zb-if branch that's off), its nodes wait in a fragment, its park.

  #slots = new Map(); // name → { name, nodes, region, park }
  #observer = null;

  #slot(name) {
    let record = this.#slots.get(name);
    if (!record) {
      record = { name, nodes: [], region: null, park: document.createDocumentFragment() };
      this.#slots.set(name, record);
      this.#observer?.observe(record.park, { childList: true });
    }
    return record;
  }
  #collectSlots() {
    const children = [...this.childNodes];
    @assignSlots(children).forEach((name, i) => {
      this.#warnSlot(name, children[i]);
      const record = this.#slot(name);
      record.nodes.push(children[i]);
      record.park.append(children[i]);
    });
  }
  /** A slot between `start` and `end`, showing its nodes or `fallback()`. */
  #slotRegion(start, end, name, fallback) {
    const record = this.#slot(name);
    const region = {
      start,
      end,
      provided: false,
      fallback: null,
      update: (keep = null) => {
        // Content a framework removed through its real parent (Vue does) has left, even before the
        // MutationObserver says so: it mustn't be put back.
        record.nodes = record.nodes.filter((node) => node === keep || node.parentNode === start.parentNode || node.parentNode === record.park);
        region.provided = record.nodes.some(@isContent);
        if (region.provided) {
          if (region.fallback) {
            while (start.nextSibling !== end) start.nextSibling.remove();
            region.fallback = null;
          }
          let cursor = start.nextSibling;
          for (const node of record.nodes) {
            this.#mark(node);
            if (node === cursor) cursor = cursor.nextSibling;
            else @move(start.parentNode, node, cursor);
          }
          return;
        }
        // Only markers and whitespace (a framework's bookkeeping): they wait in the park, where the
        // framework can still add content next to them, while the fallback shows.
        if (record.nodes.length) record.park.append(...record.nodes);
        if (fallback && !region.fallback) {
          while (start.nextSibling !== end) start.nextSibling.remove();
          const block = fallback();
          block.update();
          @insert(end.parentNode, block.nodes, end);
          region.fallback = block.update;
        }
        region.fallback?.();
      },
    };
    record.region = region;
    return () => {
      record.region = region;
      region.update();
    };
  }
  #mark(node) {
    if (@@styled && node.nodeType === 1) node.setAttribute("data-zb-slotted", this.localName);
  }
  #unmark(node) {
    if (@@styled && node.nodeType === 1 && node.getAttribute("data-zb-slotted") === this.localName) node.removeAttribute("data-zb-slotted");
  }
  #warnSlot(name, node) {
    if (@isContent(node) && !@@slots.includes(name)) console.warn(`zubra: <${this.localName}> has no slot named "${name}"; that content is not shown`);
  }
  #holding(node) {
    for (const record of this.#slots.values()) if (record.nodes.includes(node)) return record;
    return null;
  }
  // Drops content that left through its real parent (or was moved elsewhere), except `keep`.
  #show(record, keep) {
    const home = record.region?.provided ? record.region.start.parentNode : record.park;
    const kept = record.nodes.filter((node) => node === keep || node.parentNode === home);
    for (const node of record.nodes) if (!kept.includes(node)) this.#unmark(node);
    record.nodes = kept;
    if (record.region) record.region.update(keep);
    else record.park.append(...record.nodes);
    this.#requestUpdate(); // hasSlot() and the rest may have changed
  }
  #take(node) {
    const record = this.#holding(node);
    if (record) record.nodes.splice(record.nodes.indexOf(node), 1);
    return record;
  }
  #route(node, before) {
    if (node.nodeType === 11) {
      for (const child of [...node.childNodes]) this.#route(child, before);
      return;
    }
    const from = this.#take(node);
    // A marker or whitespace goes in the slot of what it's inserted before.
    const name = @isContent(node) ? @slotName(node) : (before && this.#holding(before)?.name) || "default";
    this.#warnSlot(name, node);
    const record = this.#slot(name);
    const at = before ? record.nodes.indexOf(before) : -1;
    record.nodes.splice(at < 0 ? record.nodes.length : at, 0, node);
    if (from && from !== record) this.#show(from);
    this.#show(record, node);
  }
  #remove(node) {
    const record = this.#take(node);
    if (!record) return false;
    this.#unmark(node);
    node.remove();
    this.#show(record);
    return true;
  }
  #clearSlots() {
    for (const record of this.#slots.values()) {
      for (const node of record.nodes.splice(0)) {
        this.#unmark(node);
        node.remove();
      }
      this.#show(record);
    }
  }
  /** A zb-if branch is going away: the slotted content inside it waits in the parks. */
  #parkSlotsIn(start, end) {
    for (const record of this.#slots.values()) {
      const region = record.region;
      if (!region) continue;
      let inside = false;
      for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
        if (node === region.start || node.contains?.(region.start)) {
          inside = true;
          break;
        }
      }
      if (!inside) continue;
      record.region = null;
      record.park.append(...record.nodes);
    }
  }
  // Content removed or moved through its real parent (Vue removes via parentNode; Lit and Svelte
  // change content next to their markers), and content whose slot attribute changed.
  #observe() {
    this.#observer = new MutationObserver((records) => {
      for (const record of records) {
        const slot = record.type === "attributes" && this.#holding(record.target);
        if (slot && @slotName(record.target) !== slot.name) this.#route(record.target, null);
      }
      for (const slot of this.#slots.values()) {
        let actual;
        if (slot.region?.provided) {
          actual = [];
          for (let node = slot.region.start.nextSibling; node && node !== slot.region.end; node = node.nextSibling) actual.push(node);
        } else {
          actual = [...slot.park.childNodes];
        }
        if (actual.length === slot.nodes.length && actual.every((node, i) => node === slot.nodes[i])) continue;
        for (const node of slot.nodes) if (!actual.includes(node)) this.#unmark(node);
        slot.nodes = actual;
        // An element that belongs to another slot (added next to a marker here) goes there.
        for (const node of actual) if (node.nodeType === 1 && @slotName(node) !== slot.name) this.#route(node, null);
        this.#show(slot);
      }
    });
    this.#observer.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ["slot"] });
    for (const record of this.#slots.values()) this.#observer.observe(record.park, { childList: true });
  }

  // Frameworks keep managing what they gave the element through the element itself (React calls
  // insertBefore and removeChild on it, Vue sets textContent): once it has started, those go to
  // the slots.
  insertBefore(node, before) {
    if (!this.#started) return super.insertBefore(node, before);
    this.#route(node, before ?? null);
    return node;
  }
  appendChild(node) {
    if (!this.#started) return super.appendChild(node);
    this.#route(node, null);
    return node;
  }
  append(...items) {
    if (!this.#started) return super.append(...items);
    for (const item of items) this.#route(item instanceof Node ? item : document.createTextNode(String(item)), null);
  }
  removeChild(node) {
    if (this.#started && this.#remove(node)) return node;
    return super.removeChild(node);
  }
  replaceChild(node, old) {
    if (!this.#started || !this.#holding(old)) return super.replaceChild(node, old);
    this.#route(node, old);
    this.#remove(old);
    return old;
  }
  replaceChildren(...items) {
    if (!this.#started) return super.replaceChildren(...items);
    this.#clearSlots();
    this.append(...items);
  }
  get textContent() {
    return super.textContent;
  }
  set textContent(value) {
    if (!this.#started) {
      super.textContent = value;
      return;
    }
    this.#clearSlots();
    if (value != null && value !== "") this.#route(document.createTextNode(String(value)), null);
  }
  get innerHTML() {
    return super.innerHTML;
  }
  set innerHTML(value) {
    if (!this.#started) {
      super.innerHTML = value;
      return;
    }
    this.#clearSlots();
    const template = document.createElement("template");
    template.innerHTML = value;
    this.#route(document.importNode(template.content, true), null);
  }
