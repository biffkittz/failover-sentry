<script setup lang="ts">
/** Container for a region card: fetches its monitor's probe history and runs the recovery action. */
import type { RegionView } from '@failover-sentry/contracts';
import { computed } from 'vue';
import { useRegionMonitor } from '@/composables/use-region-data';
import { useNotificationsStore } from '@/stores/notifications';
import { useSentryStore } from '@/stores/sentry';
import RegionCard from './region-card.vue';

const props = defineProps<{ region: RegionView }>();

const sentry = useSentryStore();
const notifications = useNotificationsStore();
const monitor = useRegionMonitor(() => props.region.config.id);
const probes = computed(() => monitor.data.value?.probes);

async function recover(regionId: string): Promise<void> {
  try {
    await sentry.recoverRegion(regionId);
    notifications.info(
      'Recovery started',
      `The sentry is starting ${regionId} and will wait for it to rejoin as a standby.`,
    );
  } catch (error) {
    notifications.error(`Could not recover ${regionId}`, (error as Error).message);
  }
}
</script>

<template>
  <RegionCard
    :region="region"
    :probes="probes"
    :recovering="sentry.isPending(`recover:${region.config.id}`)"
    @recover="recover"
  />
</template>
