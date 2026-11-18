/**
 * Keeps keyboard focus inside a dialog while it is open, and gives it back to whatever had it before when it
 * closes (WAI-ARIA dialog pattern).
 */
import { nextTick, onScopeDispose, watch, type Ref } from 'vue';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(container: Ref<HTMLElement | null>, active: Ref<boolean>) {
  let previouslyFocused: HTMLElement | null = null;

  const focusables = (): HTMLElement[] =>
    container.value
      ? [...container.value.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (element) => !element.hasAttribute('inert'),
        )
      : [];

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !container.value) {
      return;
    }
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  watch(
    active,
    async (isActive) => {
      if (isActive) {
        previouslyFocused = document.activeElement as HTMLElement | null;
        document.addEventListener('keydown', onKeydown);
        await nextTick();
        const preferred = container.value?.querySelector<HTMLElement>('[data-autofocus]');
        (preferred ?? focusables()[0] ?? container.value)?.focus();
      } else {
        document.removeEventListener('keydown', onKeydown);
        previouslyFocused?.focus?.();
        previouslyFocused = null;
      }
    },
    { immediate: true },
  );

  // A dialog removed with v-if never sees `active` turn false: restore focus when it is torn down, too.
  onScopeDispose(() => {
    document.removeEventListener('keydown', onKeydown);
    if (previouslyFocused) {
      const target = previouslyFocused;
      previouslyFocused = null;
      requestAnimationFrame(() => target.focus?.());
    }
  });
}
