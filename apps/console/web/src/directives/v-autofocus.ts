/**
 * `v-autofocus`: focuses an element when it mounts (for single-purpose pages like the sign-in screen). Respects an
 * explicit `false` binding, so it can be switched off conditionally.
 */
import type { Directive } from 'vue';

export const vAutofocus: Directive<HTMLElement, boolean | undefined> = {
  mounted(element, binding) {
    if (binding.value !== false) {
      element.focus({ preventScroll: false });
    }
  },
};
