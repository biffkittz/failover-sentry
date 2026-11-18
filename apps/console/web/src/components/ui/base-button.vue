<script setup lang="ts">
/** The one button. Variants carry meaning (danger = irreversible), and `loading` keeps it accessible while busy. */
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
    size?: 'sm' | 'md';
    type?: 'button' | 'submit' | 'reset';
    loading?: boolean;
    disabled?: boolean;
  }>(),
  { variant: 'secondary', size: 'md', type: 'button', loading: false, disabled: false },
);
</script>

<template>
  <button
    :type="type"
    class="button"
    :class="[`button--${variant}`, `button--${size}`, { 'button--loading': loading }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="button__spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

.button--md {
  min-height: 2.5rem;
  padding: 0 var(--space-4);
}

.button--sm {
  min-height: 2rem;
  padding: 0 var(--space-3);
  font-size: 0.875rem;
}

.button--primary {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.button--primary:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.button--secondary {
  background: var(--color-surface);
  border-color: var(--color-border);
  color: var(--color-text);
}

.button--secondary:hover:not(:disabled) {
  background: var(--color-surface-muted);
}

.button--danger {
  background: var(--color-danger);
  color: var(--color-on-danger);
}

.button--danger:hover:not(:disabled) {
  background: var(--color-danger-hover);
}

.button--ghost {
  background: transparent;
  color: var(--color-text);
}

.button--ghost:hover:not(:disabled) {
  background: var(--color-surface-muted);
}

.button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.button__spinner {
  width: 1em;
  height: 1em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 700ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
