<script setup lang="ts">
/** The sentry's timeline, filtered by minimum severity (presentational; rows memoised, they never change). */
import type { AlertSeverity, TimelineEvent } from '@failover-sentry/contracts';
import { computed } from 'vue';
import EmptyState from '@/components/ui/empty-state.vue';
import RelativeTime from '@/components/ui/relative-time.vue';

const props = withDefaults(
  defineProps<{ events: TimelineEvent[]; minimumSeverity?: AlertSeverity; limit?: number }>(),
  {
    minimumSeverity: 'info',
    limit: 200,
  },
);

const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };
const shown = computed(() =>
  props.events.filter((event) => RANK[event.severity] >= RANK[props.minimumSeverity]).slice(0, props.limit),
);
</script>

<template>
  <EmptyState
    v-if="shown.length === 0"
    title="Nothing yet"
    message="Events appear as the sentry observes and acts."
  />
  <ol v-else class="timeline">
    <li
      v-for="event in shown"
      :key="event.id"
      v-memo="[event.id]"
      class="timeline__item"
      :class="`timeline__item--${event.severity}`"
    >
      <span class="timeline__kind mono">{{ event.kind }}</span>
      <span class="timeline__message">{{ event.message }}</span>
      <RelativeTime class="timeline__time" :iso="event.at" />
    </li>
  </ol>
</template>

<style scoped>
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
}

.timeline__item {
  display: grid;
  grid-template-columns: minmax(8rem, 13rem) 1fr auto;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--color-border);
  background: var(--color-surface);
  font-size: 0.9rem;
}

.timeline__item--warning {
  border-left-color: var(--color-degraded);
}

.timeline__item--critical {
  border-left-color: var(--color-unhealthy);
}

.timeline__kind {
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

.timeline__message {
  overflow-wrap: anywhere;
}

.timeline__time {
  color: var(--color-text-muted);
  white-space: nowrap;
}

@media (max-width: 40rem) {
  .timeline__item {
    grid-template-columns: 1fr;
    gap: var(--space-1);
  }
}
</style>
