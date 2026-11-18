<script setup lang="ts">
/**
 * A local error boundary: a failure inside one panel shows a fallback there instead of taking the page down. The
 * error is still reported (the global handler sees it, because the hook returns nothing).
 */
import { onErrorCaptured, ref } from 'vue';
import { reportError } from '@/plugins/error-reporting';

const props = withDefaults(defineProps<{ label?: string }>(), { label: 'This panel' });
const error = ref<Error | null>(null);

onErrorCaptured((captured) => {
  error.value = captured instanceof Error ? captured : new Error(String(captured));
  reportError(captured, `boundary:${props.label}`);
  return false;
});
</script>

<template>
  <div v-if="error" class="boundary" role="alert">
    <p class="boundary__title">{{ label }} failed to render.</p>
    <p class="boundary__message">{{ error.message }}</p>
    <button type="button" class="boundary__retry" @click="error = null">Try again</button>
  </div>
  <slot v-else />
</template>

<style scoped>
.boundary {
  border: 1px solid var(--color-unhealthy);
  background: var(--color-unhealthy-bg);
  color: var(--color-text);
  border-radius: var(--radius-md);
  padding: var(--space-4);
}

.boundary__title {
  font-weight: 600;
  margin: 0;
}

.boundary__message {
  margin: var(--space-2) 0;
  color: var(--color-text-muted);
}

.boundary__retry {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}
</style>
