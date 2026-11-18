<script setup lang="ts">
import type { HealthStatus } from '@failover-sentry/contracts';
import { computed } from 'vue';
import { STATUS_LABELS } from '@/utils/format';
import StatusBadge from './status-badge.vue';
import type { BadgeTone } from './types';

const props = defineProps<{ status: HealthStatus }>();

const tone = computed<BadgeTone>(() => {
  switch (props.status) {
    case 'HEALTHY':
      return 'healthy';
    case 'DEGRADED':
      return 'degraded';
    case 'UNHEALTHY':
      return 'unhealthy';
    default:
      return 'unknown';
  }
});
</script>

<template>
  <StatusBadge :tone="tone" :label="STATUS_LABELS[status]" />
</template>
