<script setup lang="ts">
/** Turns automatic failover on or off (an Update to the sentry), optimistically, with a toast either way. */
import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useNotificationsStore } from '@/stores/notifications';
import { useSentryStore } from '@/stores/sentry';

const sentry = useSentryStore();
const auth = useAuthStore();
const notifications = useNotificationsStore();

const enabled = computed(() => sentry.state?.autoFailoverEnabled ?? false);
const busy = computed(() => sentry.isPending('auto-failover'));

async function toggle(): Promise<void> {
  const next = !enabled.value;
  try {
    await sentry.setAutoFailover(next);
    notifications.success(
      `Automatic failover ${next ? 'enabled' : 'disabled'}`,
      `Recorded in the sentry's history as ${auth.user?.login ?? 'you'}.`,
    );
  } catch (error) {
    notifications.error('Could not change automatic failover', (error as Error).message);
  }
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="toggle"
    :class="{ 'toggle--on': enabled }"
    :aria-checked="enabled"
    :disabled="busy || !sentry.isRunning"
    @click="toggle"
  >
    <span class="toggle__track" aria-hidden="true"><span class="toggle__thumb" /></span>
    <span class="toggle__label">Automatic failover {{ enabled ? 'on' : 'off' }}</span>
  </button>
</template>

<style scoped>
.toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  border: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  cursor: pointer;
  padding: var(--space-1);
  border-radius: var(--radius-sm);
}

.toggle:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.toggle__track {
  width: 2.5rem;
  height: 1.4rem;
  border-radius: var(--radius-pill);
  background: var(--color-border);
  position: relative;
  transition: background-color 150ms ease;
}

.toggle__thumb {
  position: absolute;
  top: 0.15rem;
  left: 0.15rem;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  transition: transform 150ms ease;
}

.toggle--on .toggle__track {
  background: var(--color-healthy);
}

.toggle--on .toggle__thumb {
  transform: translateX(1.1rem);
}

.toggle__label {
  font-weight: 600;
  font-size: 0.9rem;
}
</style>
