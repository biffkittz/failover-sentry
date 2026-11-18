<script setup lang="ts">
/** A failover's steps in order, with status, timing and detail (presentational). */
import type { FailoverRun, StepStatus } from '@failover-sentry/contracts';
import { useNow } from '@/composables/use-now';
import { duration, STEP_LABELS, STEP_STATUS_LABELS } from '@/utils/format';

defineProps<{ run: FailoverRun }>();
const now = useNow();

const ICONS: Record<StepStatus, string> = {
  PENDING: '○',
  RUNNING: '◐',
  SUCCEEDED: '✓',
  WARNING: '!',
  FAILED: '✕',
  SKIPPED: '–',
  CANCELLED: '⊘',
};
</script>

<template>
  <ol class="stepper">
    <li
      v-for="step in run.steps"
      :key="step.name"
      v-memo="[step.status, step.detail, step.endedAt, step.status === 'RUNNING' ? now : 0]"
      class="stepper__step"
      :class="`stepper__step--${step.status.toLowerCase()}`"
      :aria-current="step.status === 'RUNNING' ? 'step' : undefined"
    >
      <span class="stepper__icon" aria-hidden="true">{{ ICONS[step.status] }}</span>
      <div class="stepper__body">
        <p class="stepper__title">
          {{ STEP_LABELS[step.name] }}
          <span class="stepper__status">{{ STEP_STATUS_LABELS[step.status] }}</span>
          <span v-if="step.startedAt" class="stepper__time">{{
            duration(step.startedAt, step.endedAt, now)
          }}</span>
        </p>
        <p v-if="step.detail" class="stepper__detail">{{ step.detail }}</p>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.stepper {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}

.stepper__step {
  display: grid;
  grid-template-columns: 1.75rem 1fr;
  gap: var(--space-2);
  align-items: start;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
}

.stepper__step--running {
  background: var(--color-info-bg);
}

.stepper__icon {
  display: inline-grid;
  place-items: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  font-weight: 700;
  background: var(--color-unknown-bg);
  color: var(--color-unknown);
}

.stepper__step--succeeded .stepper__icon {
  background: var(--color-healthy-bg);
  color: var(--color-healthy);
}

.stepper__step--warning .stepper__icon,
.stepper__step--running .stepper__icon {
  background: var(--color-degraded-bg);
  color: var(--color-degraded);
}

.stepper__step--failed .stepper__icon,
.stepper__step--cancelled .stepper__icon {
  background: var(--color-unhealthy-bg);
  color: var(--color-unhealthy);
}

.stepper__title {
  margin: 0;
  font-weight: 600;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: baseline;
}

.stepper__status,
.stepper__time {
  font-weight: 400;
  font-size: 0.85rem;
  color: var(--color-text-muted);
}

.stepper__detail {
  margin: var(--space-1) 0 0;
  font-size: 0.9rem;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}
</style>
