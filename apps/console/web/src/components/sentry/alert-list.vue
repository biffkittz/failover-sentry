<script setup lang="ts">
/** Alerts, newest first, with delivery status and acknowledgement (presentational). */
import type { AlertRecord } from '@failover-sentry/contracts';
import { computed } from 'vue';
import BaseButton from '@/components/ui/base-button.vue';
import EmptyState from '@/components/ui/empty-state.vue';
import RelativeTime from '@/components/ui/relative-time.vue';
import StatusBadge from '@/components/ui/status-badge.vue';
import type { BadgeTone } from '@/components/ui/types';

const props = withDefaults(defineProps<{ alerts: AlertRecord[]; limit?: number; pendingIds?: string[] }>(), {
  limit: 50,
  pendingIds: () => [],
});
defineEmits<{ acknowledge: [alertId: string] }>();

const shown = computed(() => props.alerts.slice(0, props.limit));
const TONES: Record<AlertRecord['severity'], BadgeTone> = {
  info: 'info',
  warning: 'degraded',
  critical: 'unhealthy',
};
</script>

<template>
  <EmptyState
    v-if="shown.length === 0"
    title="No alerts"
    message="The sentry raises alerts for failovers, stalls and fencing."
  />
  <ul v-else class="alerts">
    <li
      v-for="alert in shown"
      :key="alert.id"
      class="alert"
      :class="{ 'alert--acknowledged': alert.acknowledgedBy }"
    >
      <div class="alert__head">
        <StatusBadge :tone="TONES[alert.severity]" :label="alert.severity" />
        <strong class="alert__title">{{ alert.title }}</strong>
        <RelativeTime class="alert__time" :iso="alert.at" />
      </div>
      <p class="alert__message">{{ alert.message }}</p>
      <div class="alert__foot">
        <span class="alert__delivery"
          >Delivery: {{ alert.delivery
          }}<template v-if="alert.deliveryDetail"> ({{ alert.deliveryDetail }})</template></span
        >
        <RouterLink
          v-if="alert.failoverId"
          :to="{ name: 'failover', params: { failoverId: alert.failoverId } }"
        >
          Failover {{ alert.failoverId }}
        </RouterLink>
        <span v-if="alert.acknowledgedBy" class="alert__ack">Acknowledged by {{ alert.acknowledgedBy }}</span>
        <BaseButton
          v-else
          size="sm"
          variant="ghost"
          :loading="pendingIds.includes(alert.id)"
          @click="$emit('acknowledge', alert.id)"
        >
          Acknowledge
        </BaseButton>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.alerts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-3);
}

.alert {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
}

.alert--acknowledged {
  opacity: 0.75;
}

.alert__head,
.alert__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}

.alert__title {
  flex: 1;
  min-width: 10rem;
}

.alert__time,
.alert__delivery,
.alert__ack {
  font-size: 0.85rem;
  color: var(--color-text-muted);
}

.alert__message {
  margin: var(--space-2) 0;
  overflow-wrap: anywhere;
}
</style>
