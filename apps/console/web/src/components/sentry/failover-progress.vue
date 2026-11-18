<script setup lang="ts">
/**
 * The failover in progress: what triggered it, its steps, and the operator's levers. Abort cancels the sentry's
 * failover scope (and it compensates); a stalled replication offers keep waiting, retry as forced, or abort.
 */
import type { StallDecision } from '@failover-sentry/contracts';
import { computed, ref } from 'vue';
import BaseButton from '@/components/ui/base-button.vue';
import BaseCard from '@/components/ui/base-card.vue';
import BaseModal from '@/components/ui/base-modal.vue';
import RelativeTime from '@/components/ui/relative-time.vue';
import { useNotificationsStore } from '@/stores/notifications';
import { useSentryStore } from '@/stores/sentry';
import { phaseLabel } from '@/utils/format';
import FailoverStepper from './failover-stepper.vue';

const sentry = useSentryStore();
const notifications = useNotificationsStore();
const run = computed(() => sentry.currentFailover);
const abortOpen = ref(false);
const abortReason = ref('');
const abortReasonValid = computed(() => abortReason.value.trim().length >= 3);
const canAbort = computed(
  () => run.value !== null && run.value.phase !== 'COMPENSATING' && run.value.phase !== 'DONE',
);

async function confirmAbort(): Promise<void> {
  try {
    const result = await sentry.abortFailover(abortReason.value.trim());
    notifications.warning(
      'Failover aborted',
      `The sentry is reverting ${result.failoverId} (aborted during ${phaseLabel(result.abortedDuringPhase)}).`,
    );
    abortOpen.value = false;
    abortReason.value = '';
  } catch (error) {
    notifications.error('Could not abort', (error as Error).message);
  }
}

async function decide(decision: StallDecision): Promise<void> {
  try {
    await sentry.resolveStall(decision);
    notifications.info(
      'Decision sent',
      decision === 'keep-waiting'
        ? 'The sentry keeps waiting for replication.'
        : decision === 'retry-forced'
          ? 'The sentry retries the promotion as forced.'
          : 'The sentry is reverting the failover.',
    );
  } catch (error) {
    notifications.error('Could not send the decision', (error as Error).message);
  }
}
</script>

<template>
  <BaseCard v-if="run" title="Failover in progress" highlighted>
    <template #actions>
      <BaseButton v-if="canAbort" variant="danger" size="sm" @click="abortOpen = true"
        >Abort failover</BaseButton
      >
    </template>
    <p class="summary">
      <strong>{{ run.trigger === 'AUTOMATIC' ? 'Automatic' : 'Manual' }} {{ run.mode }} failover</strong>
      {{ run.fromRegionId }} → {{ run.toRegionId }} · epoch <span class="mono">{{ run.epoch }}</span> ·
      started
      <RelativeTime :iso="run.startedAt" />
      <template v-if="run.requestedBy"> by {{ run.requestedBy }}</template>
    </p>
    <p class="reason">{{ run.reason }}</p>
    <p class="phase" role="status" aria-live="polite">Now: {{ phaseLabel(run.phase) }}</p>

    <div v-if="run.phase === 'AWAITING_OPERATOR'" class="stall" role="alert">
      <p class="stall__title">Replica sync stalled</p>
      <p class="stall__text">
        {{ run.toRegionId }} hasn't confirmed its promotion. Without a decision the sentry reverts
        automatically.
      </p>
      <div class="stall__actions">
        <BaseButton size="sm" :loading="sentry.isPending('stall')" @click="decide('keep-waiting')"
          >Keep waiting</BaseButton
        >
        <BaseButton size="sm" :loading="sentry.isPending('stall')" @click="decide('retry-forced')"
          >Retry as forced</BaseButton
        >
        <BaseButton size="sm" variant="danger" :loading="sentry.isPending('stall')" @click="decide('abort')"
          >Abort and revert</BaseButton
        >
      </div>
    </div>

    <FailoverStepper :run="run" />

    <BaseModal
      :open="abortOpen"
      title="Abort this failover?"
      description="The sentry cancels the failover immediately and compensates: it moves traffic and the primary database back if the old primary can serve."
      @close="abortOpen = false"
    >
      <form class="abort" @submit.prevent="confirmAbort">
        <label for="abort-reason" class="abort__label">Reason (recorded in the sentry's history)</label>
        <textarea id="abort-reason" v-model="abortReason" data-autofocus rows="3" maxlength="500" required />
        <div class="abort__actions">
          <BaseButton @click="abortOpen = false">Keep going</BaseButton>
          <BaseButton
            type="submit"
            variant="danger"
            :disabled="!abortReasonValid"
            :loading="sentry.isPending('abort')"
          >
            Abort failover
          </BaseButton>
        </div>
      </form>
    </BaseModal>
  </BaseCard>
</template>

<style scoped>
.summary {
  margin: 0;
}

.reason {
  margin: var(--space-2) 0;
  color: var(--color-text-muted);
}

.phase {
  font-weight: 600;
  margin: 0 0 var(--space-3);
}

.stall {
  border: 1px solid var(--color-unhealthy);
  background: var(--color-unhealthy-bg);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-4);
}

.stall__title {
  margin: 0;
  font-weight: 700;
  color: var(--color-unhealthy);
}

.stall__text {
  margin: var(--space-1) 0 var(--space-3);
}

.stall__actions,
.abort__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.abort {
  display: grid;
  gap: var(--space-2);
}

.abort__label {
  font-weight: 600;
}

.abort textarea {
  font: inherit;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
}

.abort__actions {
  justify-content: flex-end;
  margin-top: var(--space-2);
}
</style>
