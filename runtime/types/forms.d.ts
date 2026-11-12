/** The model prop of a Zubra control (`value` by default), with its `<prop>change` event. */
export interface FieldOptions {
  prop?: string;
}

/** React Hook Form's `register(name)` result (the parts used). */
export interface Registration {
  name: string;
  ref: unknown;
  onChange(event: { type: string; target: { name: string; value: unknown } }): unknown;
  onBlur(event: { type: string; target: { name: string; value: unknown } }): unknown;
  disabled?: boolean;
}

/** React Hook Form's `register(name)` as props for a wrapped Zubra control (model: `value`). */
export declare function registerProps(registration: Registration): Record<string, unknown>;

/** A React Hook Form `<Controller>` field, or a TanStack Form field API. */
export type ReactField =
  | { name: string; value: unknown; onChange(value: unknown): void; onBlur(): void; ref?: unknown }
  | { name: string; state: { value: unknown }; handleChange(value: any): void; handleBlur(): void };

/** A field's props for a wrapped Zubra control in React. */
export declare function fieldProps(field: ReactField, options?: FieldOptions): Record<string, unknown>;

/** A field's props for a wrapped Zubra control in Vue, from VeeValidate's `useField()` or a `<Field>` slot's `field`. */
export declare function vueFieldProps(field: object, options?: FieldOptions): Record<string, unknown>;

/** Felte's `createField(name)` result (the parts used). */
export interface FelteField {
  field(node: HTMLElement): { destroy?(): void } | void;
  onInput(value: unknown): void;
  onBlur(): void;
}

/** Connect a Zubra control to a Felte field: a Svelte action, or call it with the element. */
export declare function felteControl(node: HTMLElement, field: FelteField, options?: FieldOptions): { destroy(): void };
