<script setup lang="ts">
import { computed } from 'vue';
import ChaosPanel from '@/components/sentry/chaos-panel.vue';
import RegionPanel from '@/components/sentry/region-panel.vue';
import AsyncContent from '@/components/ui/async-content.vue';
import BaseCard from '@/components/ui/base-card.vue';
import EmptyState from '@/components/ui/empty-state.vue';
import { useRegionMonitor } from '@/composables/use-region-data';
import { useSentryStore } from '@/stores/sentry';

const props = defineProps<{ regionId: string }>();
const sentry = useSentryStore();
const region = computed(() => sentry.regionById(props.regionId));
const monitor = useRegionMonitor(() => props.regionId);
const probes = computed(() => [...(monitor.data.value?.probes ?? [])].reverse().slice(0, 20));
</script>

<template>
  <div class="page">
    <h1 tabindex="-1">{{ region?.config.displayName ?? regionId }}</h1>
    <template v-if="region">
      <RegionPanel :region="region" />
      <ChaosPanel :region-id="region.config.id" :region-name="region.config.displayName" />
      <BaseCard title="Latest probes">
        <AsyncContent
          :data="monitor.data.value"
          :loading="monitor.isPending.value"
          :error="monitor.error.value"
          @retry="monitor.refetch()"
        >
          <template #default>
            <div class="table-wrap">
              <table class="probes">
                <caption class="visually-hidden">
                  Latest health probes of
                  {{
                    region.config.displayName
                  }}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Result</th>
                    <th scope="col">Latency</th>
                    <th scope="col">Database</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="probe in probes" :key="probe.at" v-memo="[probe.at]">
                    <td>{{ new Date(probe.at).toLocaleTimeString() }}</td>
                    <td>{{ probe.ok ? 'ok' : (probe.error ?? 'failed') }}</td>
                    <td>{{ probe.latencyMs }} ms</td>
                    <td>{{ probe.db ? `${probe.db.role} · epoch ${probe.db.epoch}` : '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </AsyncContent>
      </BaseCard>
    </template>
    <EmptyState
      v-else
      title="Unknown region"
      :message="`The sentry doesn't monitor a region called ${regionId}.`"
    />
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

.table-wrap {
  overflow-x: auto;
}

.probes {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.probes th,
.probes td {
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
}
</style>
