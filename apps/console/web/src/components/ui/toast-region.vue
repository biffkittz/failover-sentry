<script setup lang="ts">
/** Toasts, announced politely to assistive technology; errors are announced assertively. */
import { computed } from 'vue';
import { useNotificationsStore } from '@/stores/notifications';

const notifications = useNotificationsStore();
const polite = computed(() => notifications.toasts.filter((toast) => toast.tone !== 'error'));
const assertive = computed(() => notifications.toasts.filter((toast) => toast.tone === 'error'));
</script>

<template>
  <div class="toasts">
    <div aria-live="polite" class="toasts__stack">
      <div v-for="toast in polite" :key="toast.id" class="toast" :class="`toast--${toast.tone}`">
        <div class="toast__text">
          <p class="toast__title">{{ toast.title }}</p>
          <p v-if="toast.message" class="toast__message">{{ toast.message }}</p>
        </div>
        <button
          type="button"
          class="toast__dismiss"
          aria-label="Dismiss notification"
          @click="notifications.dismiss(toast.id)"
        >
          ✕
        </button>
      </div>
    </div>
    <div aria-live="assertive" role="alert" class="toasts__stack">
      <div v-for="toast in assertive" :key="toast.id" class="toast toast--error">
        <div class="toast__text">
          <p class="toast__title">{{ toast.title }}</p>
          <p v-if="toast.message" class="toast__message">{{ toast.message }}</p>
        </div>
        <button
          type="button"
          class="toast__dismiss"
          aria-label="Dismiss notification"
          @click="notifications.dismiss(toast.id)"
        >
          ✕
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(24rem, calc(100vw - 2 * var(--space-4)));
}

.toasts__stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.toast {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  border-left-width: 4px;
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}

.toast--success {
  border-left-color: var(--color-healthy);
}

.toast--info {
  border-left-color: var(--color-info);
}

.toast--warning {
  border-left-color: var(--color-degraded);
}

.toast--error {
  border-left-color: var(--color-unhealthy);
}

.toast__text {
  flex: 1;
  min-width: 0;
}

.toast__title {
  margin: 0;
  font-weight: 600;
}

.toast__message {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

.toast__dismiss {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  min-width: 1.75rem;
  min-height: 1.75rem;
  border-radius: var(--radius-sm);
}
</style>
