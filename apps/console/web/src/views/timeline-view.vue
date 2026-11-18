<script setup lang="ts">
import type { AlertSeverity } from '@failover-sentry/contracts';
import { ref } from 'vue';
import AlertList from '@/components/sentry/alert-list.vue';
import TimelineList from '@/components/sentry/timeline-list.vue';
import BaseCard from '@/components/ui/base-card.vue';
import { useAuthStore } from '@/stores/auth';
import { useNotificationsStore } from '@/stores/notifications';
import { usePreferencesStore } from '@/stores/preferences';
import { useSentryStore } from '@/stores/sentry';

const sentry = useSentryStore();
const auth = useAuthStore();
const preferences = usePreferencesStore();
const notifications = useNotificationsStore();
const acknowledging = ref<string[]>([]);
const severities: AlertSeverity[] = ['info', 'warning', 'critical'];

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
  <div class="page">
    <h1 tabindex="-1">Timeline &amp; alerts</h1>
    <BaseCard title="Alerts">
      <AlertList :alerts="sentry.alerts" :pending-ids="acknowledging" @acknowledge="acknowledge" />
    </BaseCard>
    <BaseCard title="Timeline">
      <template #actions>
        <label class="filter">
          Show
          <select v-model="preferences.timelineMinimumSeverity">
            <option v-for="severity in severities" :key="severity" :value="severity">
              {{ severity }} and above
            </option>
          </select>
        </label>
      </template>
      <TimelineList
        :events="sentry.state?.timeline ?? []"
        :minimum-severity="preferences.timelineMinimumSeverity"
      />
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

.filter {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.filter select {
  font: inherit;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
}
</style>
