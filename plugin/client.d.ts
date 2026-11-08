// Fallback typings for `.zb` imports, for files the plugin hasn't written typings next to yet.
// Add "@zubra/unplugin/client" to `types` in tsconfig.json; with `allowArbitraryExtensions`, the
// generated `x.d.zb.ts` files next to each component give exact types.
declare module '*.zb' {
  const component: any;
  export const tag: string;
  export default component;
}

// An explicit variant: `import Card from './card.zb?element'` is always the element class.
declare module '*.zb?element' {
  const element: CustomElementConstructor & {
    readonly zubra: {
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
declare module '*.zb?react' {
  const component: any;
  export default component;
}
declare module '*.zb?vue' {
  const component: any;
  export default component;
}
