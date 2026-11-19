<script setup lang="ts">
/** One region's health, role, database and recent probe latency (presentational). */
import type { ProbeResult, RegionView } from '@failover-sentry/contracts';
import { computed } from 'vue';
import BaseButton from '@/components/ui/base-button.vue';
import BaseCard from '@/components/ui/base-card.vue';
import HealthBadge from '@/components/ui/health-badge.vue';
import LatencySparkline from '@/components/ui/latency-sparkline.vue';
import RelativeTime from '@/components/ui/relative-time.vue';
import StatusBadge from '@/components/ui/status-badge.vue';

const props = defineProps<{
  region: RegionView;
  probes: ProbeResult[] | undefined;
  recovering?: boolean;
  /** The sentry is in MANUAL_INTERVENTION_REQUIRED mode. */
  manualIntervention?: boolean;
}>();
defineEmits<{ recover: [regionId: string] }>();

const health = computed(() => props.region.health);
const db = computed(() => health.value?.lastProbe?.db ?? null);
const lastProbe = computed(() => health.value?.lastProbe ?? null);
// The same rule as the sentry's validator: a standby that is stopped or unhealthy, or a primary that a failover
// fenced (stopped) before it failed and left the sentry needing manual intervention.
const canRecover = computed(() =>
  props.region.role === 'STANDBY'
    ? props.region.compute === 'stopped' || health.value?.status === 'UNHEALTHY'
    : Boolean(props.manualIntervention) && props.region.compute === 'stopped',
);
const recovery = computed(() => props.region.recovery);
</script>

<template>
  <BaseCard :title="region.config.displayName" :heading-level="3" :highlighted="region.role === 'PRIMARY'">
    <template #actions>
      <StatusBadge
        :tone="region.role === 'PRIMARY' ? 'info' : 'unknown'"
        :label="region.role === 'PRIMARY' ? 'Primary' : 'Standby'"
      />
      <HealthBadge :status="health?.status ?? 'UNKNOWN'" />
    </template>

    <dl class="facts">
      <div class="facts__item">
        <dt>Last probe</dt>
        <dd>
          <template v-if="lastProbe">
            {{ lastProbe.ok ? `${lastProbe.latencyMs} ms` : (lastProbe.error ?? 'failed') }}
            · <RelativeTime :iso="health?.observedAt" />
          </template>
          <template v-else>not probed yet</template>
        </dd>
      </div>
      <div class="facts__item">
        <dt>Database</dt>
        <dd>
          <template v-if="db">
            <strong>{{ db.role }}</strong> · epoch <span class="mono">{{ db.epoch }}</span> · log
            <span class="mono">{{ db.appliedLsn }}</span>
            <template v-if="db.role === 'replica' && db.lagSeconds !== null">
              · lag {{ db.lagSeconds }}s</template
            >
            <template
              v-if="db.promotion && db.promotion.status !== 'completed' && db.promotion.status !== 'failed'"
            >
              · promotion {{ db.promotion.status }}
            </template>
          </template>
          <template v-else>unknown</template>
        </dd>
      </div>
      <div class="facts__item">
        <dt>Compute</dt>
        <dd>
          {{ region.compute
          }}<template v-if="region.config.provider === 'azure'"> (Azure Container Apps)</template>
        </dd>
      </div>
      <div v-if="health" class="facts__item">
        <dt>Window</dt>
        <dd>
          {{ Math.round(health.windowSuccessRate * 100) }}% of {{ health.probesInWindow }} probes ok
          <template v-if="health.consecutiveFailures > 0">
            · {{ health.consecutiveFailures }} failing in a row</template
          >
        </dd>
      </div>
    </dl>

    <LatencySparkline
      v-if="probes && probes.length > 0"
      :probes="probes"
      :label="`${region.config.displayName} probe latency`"
    />

    <p v-if="recovery" class="recovery" role="status">
      Recovery {{ recovery.phase.toLowerCase().replace('_', ' ')
      }}<template v-if="recovery.detail">: {{ recovery.detail }}</template>
    </p>

    <template #footer>
      <div class="footer">
        <RouterLink :to="{ name: 'region', params: { regionId: region.config.id } }"
          >Details &amp; chaos controls</RouterLink
        >
        <BaseButton
          v-if="canRecover"
          size="sm"
          :loading="recovering"
          @click="$emit('recover', region.config.id)"
        >
          Recover region
        </BaseButton>
      </div>
    </template>
  </BaseCard>
</template>

<style scoped>
.facts {
  display: grid;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
}

.facts__item {
  display: grid;
  grid-template-columns: 6.5rem 1fr;
  gap: var(--space-2);
}

.facts dt {
  color: var(--color-text-muted);
  font-size: 0.875rem;
}

.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.recovery {
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-info-bg);
  color: var(--color-info);
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
</style>
