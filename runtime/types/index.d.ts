// @zubra/runtime: what compiled components and their scripts use.
import type { Signal } from './signal.js';

export { Signal, isNative } from './signal.js';
export { effect, scope, flush, tick, type Cleanup, type Disposal, type Scope } from './effect.js';
import type { Disposal } from './effect.js';

/** A value, or a signal holding one: what templates and most hooks accept. */
export type MaybeSignal<T> = T | Signal.State<T> | Signal.Computed<T>;

// ---- state ----------------------------------------------------------------------------------

/**
 * A writable signal (`Signal.State`). An array or plain object is held as a reactive proxy, so
 * mutating it (`push`, `splice`, a property write) updates what read that property; `raw()` gives
 * the original back.
 */
export declare function state<T>(value: T, options?: Signal.Options<T>): Signal.State<T>;
/** The original object behind reactive state's proxy, or the value itself. */
export declare function raw<T>(value: T): T;
/** A derived signal (`Signal.Computed`); what it reads is tracked automatically. */
export declare function computed<T>(fn: () => T, options?: Signal.Options<T>): Signal.Computed<T>;
/** Call `callback(next, previous)` when `source` changes (not on the first run). */
export declare function watch<T>(source: (() => T) | MaybeSignal<T>, callback: (next: T, previous: T) => void): void;

/** Async data as signals; see `resource()`. Awaitable: resolves to the current run's value. */
export interface Resource<T> extends PromiseLike<T>, Disposal {
  /** The latest run's value (or `initial`); kept while the next run is pending. */
  readonly value: T | undefined;
  readonly error: unknown;
  readonly status: 'pending' | 'ready' | 'error';
  readonly loading: boolean;
  /** Run the fetcher again. */
  refresh(): void;
  /** Stop: abort the run in flight and never run again. `using` does this through `Symbol.dispose`. */
  dispose(): void;
}
/**
 * Run `fetcher` now and whenever a signal it read before its first `await` changes; a new run
 * (or the element's removal) aborts the previous one through `signal`.
 */
export declare function resource<T>(fetcher: (context: { signal: AbortSignal }) => T | PromiseLike<T>, options?: { initial?: T }): Resource<T>;

// ---- lifecycle and the element (call during setup) -----------------------------------------

/** Run when the element is connected; may return a cleanup for when it is disconnected. */
export declare function onMount(fn: () => void | (() => void)): void;
/** Run when the element is disconnected. */
export declare function onUnmount(fn: () => void): void;
/** An id unique to this element and call, for `id`/`for`/`aria-*` attributes. */
export declare function id(): string;
/** The component's props: reading one tracks it; writing one updates the element. */
export declare function props<P extends object = Record<string, unknown>>(): P;
/** The element whose setup is running. */
export declare function host<E extends HTMLElement = HTMLElement>(): E;
/**
 * Fire a DOM event from the component (a bubbling `CustomEvent` with `detail`). The compiler
 * declares every event it sees. Returns false if a listener called `preventDefault()` on a
 * cancelable (`before…`) event.
 */
export declare function emit<Detail = unknown>(name: string, detail?: Detail): boolean;

/**
 * The signal itself, where a script passes a signal `const` along: `watch(signal(count), …)`.
 * The identity function; since 3.0, where a signal `const` in a script means its value, it keeps
 * meaning the signal.
 */
export declare function signal<T>(value: T): T;

/**
 * Whether content was given for a slot (`'default'` for the default slot), as a signal that
 * follows the content. Read it like a value in the template: `<zb-if test={hasFooter}>`.
 */
export declare function hasSlot(name?: string): Signal.State<boolean>;
/** False while the element's markup is the server's (and on the server); true once it has started. The host also gets `:state(hydrated)`. */
export declare function hydrated(): Signal.State<boolean>;
/**
 * State that follows a prop until it's assigned, and starts over when the prop changes:
 * `let left = from(seconds)` in a `.zb` script. With a second argument, it starts as that
 * value instead: `let running = from(seconds, false)`. Elsewhere, pass functions or signals.
 */
export declare function from<T>(source: T | (() => T) | Signal.State<T> | Signal.Computed<T>): Signal.Computed<T> & { set(value: T): void };
export declare function from<T>(source: unknown, start: T | (() => T) | Signal.State<T> | Signal.Computed<T>): Signal.Computed<T> & { set(value: T): void };

/**
 * In a JSX component's parameters, `value = model(0)` makes `value` two-way: assigning it fires
 * `valuechange` (like `value:model={0}` in `.zb`). Returns its argument.
 */
export declare function model<T>(value: T): T;

// ---- event helpers (the template's event modifiers, as functions) ---------------------------

type Handler<E extends Event = Event> = (this: unknown, event: E) => unknown;
/** A handler that calls `event.preventDefault()` first (`.prevent`). */
export declare function prevent<E extends Event>(fn?: Handler<E>): Handler<E>;
/** A handler that calls `event.stopPropagation()` first (`.stop`). */
export declare function stop<E extends Event>(fn?: Handler<E>): Handler<E>;
/** A handler that ignores events from inside the element (`.self`). */
export declare function selfOnly<E extends Event>(fn?: Handler<E>): Handler<E>;
/** A handler that submits the element's form after `fn` runs (`.submit`), with validation. */
export declare function submit<E extends Event>(fn?: (event: E) => unknown): (event: E) => unknown;
/**
 * A keyboard handler for `'enter'`, `'shift+enter'`, `'ctrl+k'`, … (several: `'enter, space'`).
 * The modifier keys named must be held, and the others not.
 */
export declare function keys(combinations: string, fn?: Handler<KeyboardEvent>): Handler<KeyboardEvent>;

// ---- styles ---------------------------------------------------------------------------------

/**
 * Add stylesheets (CSS text or `CSSStyleSheet`s) to every zubra shadow root, now and later: for
 * app-wide CSS such as Tailwind's output, which page styles can't carry into shadow DOM.
 * Light-DOM components already get page CSS.
 */
export declare function adoptStyles(...styles: (string | CSSStyleSheet)[]): CSSStyleSheet[];

// ---- context (the Web Components Community Group Context Protocol) -------------------------

export interface Context<T> {
  readonly defaultValue: T;
}
/** A context key, with the value consumers get when no provider answers. */
export declare function createContext<T>(defaultValue: T): Context<T>;
/** Provide `value` for `context` to every element inside this one. */
export declare function provide<T>(context: Context<T> | unknown, value: MaybeSignal<T>): void;
/** Read `context` from the nearest provider above this element, as a signal. */
export declare function inject<T>(context: Context<T>, fallback?: T): Signal.Computed<T>;
export declare function inject<T = unknown>(context: unknown, fallback?: T): Signal.Computed<T>;

export declare class ContextRequestEvent<T = unknown> extends Event {
  constructor(context: unknown, contextTarget: Element, callback: (value: T, unsubscribe?: () => void) => void, subscribe?: boolean);
  readonly context: unknown;
  readonly contextTarget: Element;
  readonly callback: (value: T, unsubscribe?: () => void) => void;
  readonly subscribe?: boolean;
}
export declare class ContextProviderEvent extends Event {
  constructor(context: unknown, contextTarget: Element);
  readonly context: unknown;
  readonly contextTarget: Element;
}

// ---- form-associated components (`form-associated` on the host) ---------------------------

/** What the form submits for this control: follows `source`. */
export declare function formValue(source: MaybeSignal<string | number | File | FormData | null | undefined> | (() => unknown)): void;
/** Validation: `check()` returns an error message, or '' / null when the value is valid. */
export declare function validity(check: () => string | null | undefined | MaybeSignal<string | null | undefined>): void;
export declare function onFormReset(fn: () => void): void;
export declare function onFormRestore(fn: (state: string | File | FormData | null, mode: 'restore' | 'autocomplete') => void): void;
export declare function onFormDisabled(fn: (disabled: boolean) => void): void;

// ---- what compiled code uses ---------------------------------------------------------------

export interface PropSpec {
  attribute: string;
  default: unknown;
  required?: boolean;
}

/** What adapters and tools read from a compiled element class (`Element.zb`). */
export interface ElementMeta {
  readonly tag: string;
  readonly props: Readonly<Record<string, Readonly<Required<PropSpec>>>>;
  readonly events: readonly string[];
  readonly slots: readonly string[];
  readonly shadow: boolean;
  readonly form: boolean;
  /** The component has a `<style>` (light DOM: slotted content is marked `data-zb-slotted`). */
  readonly styled: boolean;
}

export interface ZubraElementClass<E extends HTMLElement = HTMLElement> {
  new (): E & { readonly updateComplete: Promise<void> };
  readonly zubra: ElementMeta;
  readonly formAssociated: boolean;
  readonly observedAttributes: string[];
}

export interface Definition {
  props?: Record<string, PropSpec>;
  template?: string;
  shadow?: boolean;
  form?: boolean;
  slots?: string[];
  events?: string[];
  /** The component has a `<style>`. */
  styled?: boolean;
  /** Its stylesheet, when the module carries it (otherwise the bundler adds it to the page). */
  styles?: string | CSSStyleSheet | null;
  /** Runs once per element; returns the template's parts. */
  setup?: (props: Record<string, unknown>, emit: (name: string, detail?: unknown) => boolean) => unknown[];
}

/**
 * @internal Register a compiled component: what the compiler's JavaScript output calls. Its
 * arguments are the compiled-code interface, version `ABI`, not a public API.
 */
export declare function $define(tag: string, definition: Definition & { abi: number }): ZubraElementClass;
/** The compiled-code interface version this runtime implements. */
export declare const ABI: number;

/** Whether a URL is safe for `href`/`src`: relative, or http(s), mailto or tel. */
export declare function isSafeUrl(value: string): boolean;
/** True when every candidate in a srcset has a safe URL (the check a dynamic `srcset` gets). */
export declare function isSafeSrcset(value: string): boolean;
/** @internal Read a value that may be a signal. */
export declare function $r<T>(value: MaybeSignal<T>): T;
/** @internal A value as template text. */
export declare function $t(value: unknown): string;
