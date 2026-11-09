/** Enhance the action forms under `root`. The document is enhanced when the module loads. */
export function enhance(root: Document | ShadowRoot | Element): void;

declare global {
  interface HTMLElementEventMap {
    /** Before an action form's request; cancel it with `preventDefault()`. */
    beforeaction: CustomEvent<{ formData: FormData }>;
    /** After an action form's request. */
    action: CustomEvent<{ value: unknown } | { error: string; status: number }>;
  }
}
