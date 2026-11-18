<script setup lang="ts" generic="T">
/**
 * Renders the loading, error and success states of async data explicitly, through scoped slots. Works with any
 * source (a TanStack query, a store), so every view handles all three states the same way.
 */
defineProps<{ data: T | undefined | null; loading: boolean; error: unknown; loadingLabel?: string }>();
defineEmits<{ retry: [] }>();

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
</script>

<template>
  <div v-if="error" class="async async--error" role="alert">
    <slot name="error" :error="error" :message="message(error)">
      <p>{{ message(error) }}</p>
      <button type="button" class="async__retry" @click="$emit('retry')">Try again</button>
    </slot>
  </div>
  <div
    v-else-if="loading && (data === undefined || data === null)"
    class="async async--loading"
    role="status"
    aria-live="polite"
  >
    <slot name="loading">
      <span class="async__skeleton" aria-hidden="true" />
      <span class="visually-hidden">{{ loadingLabel ?? 'Loading…' }}</span>
    </slot>
  </div>
  <slot v-else-if="data !== undefined && data !== null" :data="data" />
  <slot v-else name="empty" />
</template>

<style scoped>
.async--error {
  color: var(--color-unhealthy);
}

.async__retry {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}

.async__skeleton {
  display: block;
  height: 3rem;
  border-radius: var(--radius-md);
  background: linear-gradient(
    90deg,
    var(--color-surface-muted),
    var(--color-border),
    var(--color-surface-muted)
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
</style>
