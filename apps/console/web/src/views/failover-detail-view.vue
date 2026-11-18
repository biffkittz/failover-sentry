<script setup lang="ts">
import { computed } from 'vue';
import FailoverProgress from '@/components/sentry/failover-progress.vue';
import FailoverStepper from '@/components/sentry/failover-stepper.vue';
import BaseCard from '@/components/ui/base-card.vue';
import EmptyState from '@/components/ui/empty-state.vue';
import RelativeTime from '@/components/ui/relative-time.vue';
import { useSentryStore } from '@/stores/sentry';
import { absoluteTime, duration, OUTCOME_LABELS } from '@/utils/format';

const props = defineProps<{ failoverId: string }>();
const sentry = useSentryStore();
const run = computed(() => sentry.failoverById(props.failoverId));
const inProgress = computed(() => sentry.currentFailover?.id === props.failoverId);
</script>

<template>
  <div class="page">
    <h1 tabindex="-1">
      Failover <span class="mono">{{ failoverId }}</span>
    </h1>
    <FailoverProgress v-if="inProgress" />
    <template v-else-if="run">
      <BaseCard title="Summary">
        <dl class="summary">
          <dt>Outcome</dt>
          <dd>{{ run.outcome ? OUTCOME_LABELS[run.outcome] : 'In progress' }}</dd>
          <dt>Route</dt>
          <dd>{{ run.fromRegionId }} → {{ run.toRegionId }} ({{ run.mode }}, epoch {{ run.epoch }})</dd>
          <dt>Trigger</dt>
          <dd>
            {{ run.trigger === 'AUTOMATIC' ? 'Automatic' : `Manual, by ${run.requestedBy}` }}:
            {{ run.reason }}
          </dd>
          <dt>Started</dt>
          <dd>{{ absoluteTime(run.startedAt) }} (<RelativeTime :iso="run.startedAt" />)</dd>
          <dt>Duration</dt>
          <dd>{{ duration(run.startedAt, run.endedAt) }}</dd>
          <template v-if="run.replication">
            <dt>Replication</dt>
            <dd>
              confirmed by {{ run.replication.source }} ({{ run.replication.status }})
              <template v-if="run.replication.dataLossTransactions"
                >, {{ run.replication.dataLossTransactions }} transactions lost</template
              >
            </dd>
          </template>
          <template v-if="run.error">
            <dt>Error</dt>
            <dd class="summary__error">{{ run.error }}</dd>
          </template>
        </dl>
      </BaseCard>
      <BaseCard title="Steps"><FailoverStepper :run="run" /></BaseCard>
      <BaseCard v-if="run.compensations.length > 0" title="Compensation">
        <ul class="compensations">
          <li v-for="(compensation, index) in run.compensations" :key="index">
            <strong>{{ compensation.action }}</strong>: {{ compensation.status.toLowerCase() }}
            <template v-if="compensation.detail"> — {{ compensation.detail }}</template>
          </li>
        </ul>
      </BaseCard>
    </template>
    <EmptyState v-else title="Failover not found" message="The sentry keeps the ten most recent failovers.">
      <RouterLink :to="{ name: 'failovers' }">Back to failovers</RouterLink>
    </EmptyState>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  gap: var(--space-4);
}

.page h1:focus {
  outline: none;
}

.summary {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-2) var(--space-4);
  margin: 0;
}

.summary dt {
  color: var(--color-text-muted);
}

.summary dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.summary__error {
  color: var(--color-unhealthy);
}

.compensations {
  margin: 0;
  padding-left: var(--space-5);
  display: grid;
  gap: var(--space-2);
}
</style>
