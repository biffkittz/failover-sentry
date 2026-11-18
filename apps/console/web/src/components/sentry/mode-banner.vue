<script setup lang="ts">
/** The sentry at a glance: connection, mode, epoch (fencing token), cooldown and automatic failover. */
import { computed } from 'vue';
import BaseButton from '@/components/ui/base-button.vue';
import RelativeTime from '@/components/ui/relative-time.vue';
import StatusBadge from '@/components/ui/status-badge.vue';
import type { BadgeTone } from '@/components/ui/types';
import { useNotificationsStore } from '@/stores/notifications';
import { useSentryStore } from '@/stores/sentry';
import AutoFailoverToggle from './auto-failover-toggle.vue';

const sentry = useSentryStore();
const notifications = useNotificationsStore();

const mode = computed(() => {
  if (!sentry.state || sentry.unavailableReason) {
    return { tone: 'unknown' as BadgeTone, label: 'Sentry not running' };
  }
  switch (sentry.state.mode) {
    case 'FAILING_OVER':
      return { tone: 'degraded' as BadgeTone, label: 'Failing over' };
    case 'MANUAL_INTERVENTION_REQUIRED':
      return { tone: 'unhealthy' as BadgeTone, label: 'Manual intervention required' };
    default:
      return { tone: 'healthy' as BadgeTone, label: 'Normal operations' };
  }
});

const connectionLabel = computed(() => {
  switch (sentry.connection) {
    case 'open':
      return 'Live';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'connecting':
      return 'Connecting…';
    default:
      return 'Offline';
  }
});

async function start(): Promise<void> {
  try {
    await sentry.startSentry();
    notifications.success(
      'Sentry started',
      'It will establish a primary and edge routing within a few probes.',
    );
  } catch (error) {
    notifications.error('Could not start the sentry', (error as Error).message);
  }
}
</script>

<template>
  <section class="banner" aria-label="Sentry status">
    <div class="banner__main">
      <StatusBadge :tone="mode.tone" :label="mode.label" />
      <template v-if="sentry.state">
        <span class="banner__fact"
          >Epoch <strong class="mono">{{ sentry.state.epoch }}</strong></span
        >
        <span class="banner__fact"
          >Primary <strong>{{ sentry.activeRegion?.config.displayName ?? '—' }}</strong></span
        >
        <span v-if="sentry.state.cooldownUntil" class="banner__fact">
          Auto-failover cooldown ends <RelativeTime :iso="sentry.state.cooldownUntil" />
        </span>
      </template>
    </div>
    <div class="banner__side">
      <AutoFailoverToggle />
      <span class="banner__connection" :class="`banner__connection--${sentry.connection}`" role="status">
        <span aria-hidden="true">●</span> {{ connectionLabel }}
      </span>
    </div>
    <p v-if="sentry.state?.autoFailoverSuspendedReason" class="banner__note" role="alert">
      Automatic failover suspended: {{ sentry.state.autoFailoverSuspendedReason }}
    </p>
    <div v-if="sentry.unavailableReason" class="banner__note banner__note--warning" role="alert">
      <span>{{ sentry.unavailableReason }}.</span>
      <BaseButton size="sm" variant="primary" :loading="sentry.isPending('start')" @click="start"
        >Start the sentry</BaseButton
      >
    </div>
  </section>
</template>

<style scoped>
.banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.banner__main,
.banner__side {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-4);
}

.banner__fact {
  color: var(--color-text-muted);
}

.banner__fact strong {
  color: var(--color-text);
}

.banner__connection {
  font-size: 0.85rem;
  color: var(--color-text-muted);
}

.banner__connection--open span {
  color: var(--color-healthy);
}

.banner__connection--reconnecting span,
.banner__connection--connecting span {
  color: var(--color-degraded);
}

.banner__note {
  flex-basis: 100%;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-unhealthy-bg);
  color: var(--color-unhealthy);
  font-weight: 600;
}

.banner__note--warning {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  background: var(--color-degraded-bg);
  color: var(--color-degraded);
}
</style>
