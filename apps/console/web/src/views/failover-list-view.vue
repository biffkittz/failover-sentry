<script setup lang="ts">
import FailoverTable from '@/components/sentry/failover-table.vue';
import BaseCard from '@/components/ui/base-card.vue';
import { useSentryStore } from '@/stores/sentry';

const sentry = useSentryStore();
</script>

<template>
  <div class="page">
    <h1 tabindex="-1">Failovers</h1>
    <BaseCard>
      <FailoverTable :runs="sentry.failovers" />
    </BaseCard>
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
</style>
