// Fallback typings for `.mnx` imports, for files the plugin hasn't written typings next to yet.
// Add "@mnx/unplugin/client" to `types` in tsconfig.json; with `allowArbitraryExtensions`, the
// generated `x.d.mnx.ts` files next to each component give exact types.
declare module '*.mnx' {
  const component: any;
  export const tag: string;
  export default component;
}

// An explicit variant: `import Card from './card.mnx?element'` is always the element class.
declare module '*.mnx?element' {
  const element: CustomElementConstructor & {
    readonly mnx: {
      readonly tag: string;
      readonly props: Readonly<Record<string, { readonly attribute: string; readonly default: unknown; readonly required: boolean }>>;
      readonly events: readonly string[];
      readonly slots: readonly string[];
      readonly shadow: boolean;
      readonly form: boolean;
    };
  };
  export const tag: string;
  export default element;
}
declare module '*.mnx?react' {
  const component: any;
  export default component;
}
declare module '*.mnx?vue' {
  const component: any;
  export default component;
}
