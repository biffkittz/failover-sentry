<script setup lang="ts">
/**
 * Chaos controls for one region (the "world" the sentry must react to). Settings apply optimistically through
 * TanStack Query and roll back if the region refuses.
 */
import type { ChaosSettings, ChaosUpdate } from '@failover-sentry/contracts';
import { computed, ref, watch } from 'vue';
import AsyncContent from '@/components/ui/async-content.vue';
import BaseButton from '@/components/ui/base-button.vue';
import BaseCard from '@/components/ui/base-card.vue';
import { useChaosSettings, useUpdateChaos } from '@/composables/use-region-data';
import { useNotificationsStore } from '@/stores/notifications';

const props = defineProps<{ regionId: string; regionName: string }>();

const notifications = useNotificationsStore();
const query = useChaosSettings(() => props.regionId);
const mutation = useUpdateChaos(() => props.regionId);
const draft = ref<ChaosSettings | null>(null);

watch(
  () => query.data.value,
  (settings) => {
    if (settings) {
      draft.value = { ...settings };
    }
  },
  { immediate: true },
);

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(query.data.value));

async function apply(update: ChaosUpdate, label: string): Promise<void> {
  try {
    await mutation.mutateAsync(update);
    notifications.warning(`Chaos applied to ${props.regionName}`, label);
  } catch (error) {
    notifications.error('Chaos change failed', (error as Error).message);
  }
}

function applyDraft(): void {
  if (draft.value) {
    void apply(
      { ...draft.value },
      `health ${draft.value.health}, +${draft.value.latencyMs} ms, ${Math.round(draft.value.errorRate * 100)}% errors, replication ${draft.value.replication}`,
    );
  }
}
</script>

<template>
  <BaseCard :title="`Chaos controls: ${regionName}`">
    <AsyncContent
      :data="draft"
      :loading="query.isPending.value"
      :error="query.error.value"
      @retry="query.refetch()"
    >
      <template #default="{ data }">
        <div class="presets" role="group" aria-label="Presets">
          <BaseButton
            size="sm"
            variant="danger"
            :loading="mutation.isPending.value"
            @click="apply({ health: 'down' }, 'region down: every endpoint answers 503')"
            >Take region down</BaseButton
          >
          <BaseButton
            size="sm"
            :loading="mutation.isPending.value"
            @click="apply({ latencyMs: 2500 }, '2.5 s added to every response')"
            >Add 2.5 s latency</BaseButton
          >
          <BaseButton
            size="sm"
            :loading="mutation.isPending.value"
            @click="apply({ replication: 'stalled' }, 'promotions on this region will never finish')"
            >Stall replication</BaseButton
          >
          <BaseButton
            size="sm"
            variant="primary"
            :loading="mutation.isPending.value"
            @click="
              apply(
                { health: 'healthy', latencyMs: 0, errorRate: 0, replication: 'normal' },
                'all chaos cleared',
              )
            "
            >Heal region</BaseButton
          >
        </div>
        <form class="chaos" @submit.prevent="applyDraft">
          <label class="chaos__field">
            <span>Health</span>
            <select v-model="data.health">
              <option value="healthy">Healthy</option>
              <option value="degraded">Degraded (reports degraded)</option>
              <option value="down">Down (503 everywhere)</option>
            </select>
          </label>
          <label class="chaos__field">
            <span>Added latency: {{ data.latencyMs }} ms</span>
            <input v-model.number="data.latencyMs" type="range" min="0" max="5000" step="250" />
          </label>
          <label class="chaos__field">
            <span>Error rate: {{ Math.round(data.errorRate * 100) }}%</span>
            <input v-model.number="data.errorRate" type="range" min="0" max="1" step="0.1" />
          </label>
          <label class="chaos__field">
            <span>Replication</span>
            <select v-model="data.replication">
              <option value="normal">Normal</option>
              <option value="slow">Slow (3× sync time)</option>
              <option value="stalled">Stalled (never confirms)</option>
              <option value="drop-webhook">Drop the webhook</option>
              <option value="fail">Fail promotions</option>
            </select>
          </label>
          <div class="chaos__actions">
            <BaseButton type="submit" variant="primary" :disabled="!dirty" :loading="mutation.isPending.value"
              >Apply</BaseButton
            >
          </div>
        </form>
      </template>
    </AsyncContent>
  </BaseCard>
</template>

<style scoped>
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.chaos {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  align-items: end;
}

.chaos__field {
  display: grid;
  gap: var(--space-1);
  font-weight: 600;
}

.chaos__field select {
  font: inherit;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
}

.chaos__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
