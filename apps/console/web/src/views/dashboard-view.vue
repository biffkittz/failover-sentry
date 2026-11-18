<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue';
import AlertList from '@/components/sentry/alert-list.vue';
import FailoverProgress from '@/components/sentry/failover-progress.vue';
import ModeBanner from '@/components/sentry/mode-banner.vue';
import RegionPanel from '@/components/sentry/region-panel.vue';
import TimelineList from '@/components/sentry/timeline-list.vue';
import TopologyDiagram from '@/components/sentry/topology-diagram.vue';
import BaseButton from '@/components/ui/base-button.vue';
import BaseCard from '@/components/ui/base-card.vue';
import EmptyState from '@/components/ui/empty-state.vue';
import ErrorBoundary from '@/components/ui/error-boundary.vue';
import { useAuthStore } from '@/stores/auth';
import { useNotificationsStore } from '@/stores/notifications';
import { useSentryStore } from '@/stores/sentry';

// The form (and VeeValidate with it) loads only when someone opens it.
const ManualFailoverDialog = defineAsyncComponent(
  () => import('@/components/sentry/manual-failover-dialog.vue'),
);

const sentry = useSentryStore();
const auth = useAuthStore();
const notifications = useNotificationsStore();
const dialogOpen = ref(false);
const acknowledging = ref<string[]>([]);

const recentAlerts = computed(() => sentry.openAlerts.slice(0, 5));

async function acknowledge(alertId: string): Promise<void> {
  acknowledging.value = [...acknowledging.value, alertId];
  try {
    await sentry.acknowledgeAlert(alertId, auth.user?.login ?? 'you');
  } catch (error) {
    notifications.error('Could not acknowledge the alert', (error as Error).message);
  } finally {
    acknowledging.value = acknowledging.value.filter((id) => id !== alertId);
  }
}
</script>

<template>
  <div class="dashboard">
    <div class="dashboard__title">
      <h1 tabindex="-1">Overview</h1>
      <BaseButton variant="danger" :disabled="!sentry.canTriggerFailover" @click="dialogOpen = true"
        >Emergency failover…</BaseButton
      >
    </div>

    <ModeBanner />

    <template v-if="sentry.state">
      <ErrorBoundary label="The failover panel">
        <FailoverProgress v-if="sentry.currentFailover" />
      </ErrorBoundary>

      <BaseCard title="Traffic">
        <TopologyDiagram
          :edge="sentry.state.edge"
          :edge-public-url="sentry.state.edgePublicUrl"
          :regions="sentry.regions"
          :current-failover="sentry.currentFailover"
        />
      </BaseCard>

      <section aria-labelledby="regions-title">
        <h2 id="regions-title" class="dashboard__section-title">Regions</h2>
        <div class="dashboard__regions">
          <ErrorBoundary
            v-for="region in sentry.regions"
            :key="region.config.id"
            :label="`The ${region.config.displayName} card`"
          >
            <RegionPanel :region="region" />
          </ErrorBoundary>
        </div>
      </section>

      <div class="dashboard__columns">
        <BaseCard title="Open alerts">
          <template #actions><RouterLink :to="{ name: 'timeline' }">All alerts</RouterLink></template>
          <AlertList :alerts="recentAlerts" :pending-ids="acknowledging" @acknowledge="acknowledge" />
        </BaseCard>
        <BaseCard title="Recent activity">
          <template #actions><RouterLink :to="{ name: 'timeline' }">Full timeline</RouterLink></template>
          <TimelineList :events="sentry.state.timeline" :limit="12" />
        </BaseCard>
      </div>
    </template>
    <EmptyState
      v-else-if="sentry.connection === 'connecting' || sentry.connection === 'idle'"
      title="Connecting to the sentry…"
    />

    <ManualFailoverDialog v-if="dialogOpen" :open="dialogOpen" @close="dialogOpen = false" />
  </div>
</template>

<style scoped>
.dashboard {
  display: grid;
  gap: var(--space-4);
}

.dashboard__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.dashboard__title h1 {
  margin: 0;
}

.dashboard__title h1:focus {
  outline: none;
}

.dashboard__section-title {
  font-size: 1.1rem;
}

.dashboard__regions {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fit, minmax(min(22rem, 100%), 1fr));
}

.dashboard__columns {
  display: grid;
  gap: var(--space-4);
}

@media (min-width: 64rem) {
  .dashboard__columns {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
