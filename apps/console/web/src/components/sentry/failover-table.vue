<script setup lang="ts">
/** Recent failovers as a table (presentational). */
import type { FailoverRun } from '@failover-sentry/contracts';
import EmptyState from '@/components/ui/empty-state.vue';
import RelativeTime from '@/components/ui/relative-time.vue';
import StatusBadge from '@/components/ui/status-badge.vue';
import type { BadgeTone } from '@/components/ui/types';
import { duration, OUTCOME_LABELS } from '@/utils/format';

defineProps<{ runs: FailoverRun[] }>();

function tone(run: FailoverRun): BadgeTone {
  switch (run.outcome) {
    case null:
      return 'info';
    case 'SUCCEEDED':
      return 'healthy';
    case 'REFUSED':
    case 'ABORTED':
    case 'KEPT_TARGET':
      return 'degraded';
    default:
      return 'unhealthy';
  }
}
</script>

<template>
  <EmptyState
    v-if="runs.length === 0"
    title="No failovers yet"
    message="Automatic and manual failovers appear here."
  />
  <div v-else class="table-wrap">
    <table class="table">
      <caption class="visually-hidden">
        Recent failovers
      </caption>
      <thead>
        <tr>
          <th scope="col">Failover</th>
          <th scope="col">Trigger</th>
          <th scope="col">Route</th>
          <th scope="col">Outcome</th>
          <th scope="col">Duration</th>
          <th scope="col">Started</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="run in runs" :key="run.id">
          <th scope="row">
            <RouterLink :to="{ name: 'failover', params: { failoverId: run.id } }" class="mono">{{
              run.id
            }}</RouterLink>
          </th>
          <td>
            {{ run.trigger === 'AUTOMATIC' ? 'Automatic' : `Manual (${run.requestedBy ?? 'unknown'})` }} ·
            {{ run.mode }}
          </td>
          <td>{{ run.fromRegionId }} → {{ run.toRegionId }}</td>
          <td>
            <StatusBadge
              :tone="tone(run)"
              :label="run.outcome ? OUTCOME_LABELS[run.outcome] : 'In progress'"
            />
          </td>
          <td>{{ duration(run.startedAt, run.endedAt) }}</td>
          <td><RelativeTime :iso="run.startedAt" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap {
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.table th,
.table td {
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

.table thead th {
  color: var(--color-text-muted);
  font-weight: 600;
}
</style>
