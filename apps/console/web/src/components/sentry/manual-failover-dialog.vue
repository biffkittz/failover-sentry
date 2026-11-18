<script setup lang="ts">
/**
 * The emergency failover button's form. Validated declaratively (VeeValidate with a zod schema) on blur and as you
 * type; the sentry validates again in its Update validator, and its refusal is shown here too.
 */
import type { FailoverMode } from '@failover-sentry/contracts';
import { useForm } from 'vee-validate';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { z } from 'zod';
import BaseButton from '@/components/ui/base-button.vue';
import BaseModal from '@/components/ui/base-modal.vue';
import { zodTypedSchema } from '@/composables/use-zod-schema';
import { useNotificationsStore } from '@/stores/notifications';
import { useSentryStore } from '@/stores/sentry';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const sentry = useSentryStore();
const notifications = useNotificationsStore();
const router = useRouter();
const serverError = ref<string | null>(null);

const AUTO = '__auto__';

const schema = z
  .object({
    target: z.string(),
    mode: z.enum(['planned', 'forced']),
    reason: z
      .string()
      .trim()
      .min(3, 'Say briefly why (3 characters or more).')
      .max(500, 'Keep it under 500 characters.'),
    confirmation: z.string(),
  })
  .superRefine((values, context) => {
    if (values.mode === 'forced' && values.confirmation.trim().toUpperCase() !== 'FORCE') {
      context.addIssue({
        code: 'custom',
        path: ['confirmation'],
        message: 'Type FORCE to confirm a forced failover.',
      });
    }
  });

const { defineField, handleSubmit, errors, resetForm, isSubmitting } = useForm({
  validationSchema: zodTypedSchema(schema),
  initialValues: { target: AUTO, mode: 'planned' as FailoverMode, reason: '', confirmation: '' },
});

const validateOnBlur = { validateOnBlur: true, validateOnModelUpdate: true };
const [target, targetAttrs] = defineField('target', validateOnBlur);
const [mode, modeAttrs] = defineField('mode', validateOnBlur);
const [reason, reasonAttrs] = defineField('reason', validateOnBlur);
const [confirmation, confirmationAttrs] = defineField('confirmation', validateOnBlur);

const targets = computed(() => sentry.standbyRegions);

watch(
  () => props.open,
  (open) => {
    if (open) {
      serverError.value = null;
      resetForm();
    }
  },
);

const submit = handleSubmit(async (values) => {
  serverError.value = null;
  try {
    const accepted = await sentry.triggerFailover({
      ...(values.target !== AUTO ? { targetRegionId: values.target } : {}),
      mode: values.mode,
      reason: values.reason,
    });
    notifications.warning(
      'Failover started',
      `${accepted.fromRegionId} → ${accepted.toRegionId} at epoch ${accepted.epoch}.`,
    );
    emit('close');
    await router.push({ name: 'failover', params: { failoverId: accepted.failoverId } });
  } catch (error) {
    serverError.value = (error as Error).message;
  }
});
</script>

<template>
  <BaseModal
    :open="open"
    title="Emergency failover"
    description="Move traffic and the primary database to a standby region. The sentry fences the current primary first, so there is never more than one writer."
    @close="emit('close')"
  >
    <form class="form" novalidate @submit.prevent="submit">
      <div class="field">
        <label for="failover-target" class="field__label">Target region</label>
        <select id="failover-target" v-model="target" v-bind="targetAttrs" data-autofocus>
          <option :value="AUTO">Healthiest standby (sentry decides)</option>
          <option v-for="region in targets" :key="region.config.id" :value="region.config.id">
            {{ region.config.displayName }} — {{ region.health?.status ?? 'UNKNOWN' }}
          </option>
        </select>
      </div>

      <fieldset class="field">
        <legend class="field__label">Mode</legend>
        <label class="choice">
          <input v-model="mode" v-bind="modeAttrs" type="radio" name="mode" value="planned" />
          <span
            ><strong>Planned</strong>: the replica catches up first. No data loss; needs the current primary
            reachable.</span
          >
        </label>
        <label class="choice">
          <input v-model="mode" v-bind="modeAttrs" type="radio" name="mode" value="forced" />
          <span><strong>Forced</strong>: promote now. Possible data loss; for when the primary is down.</span>
        </label>
      </fieldset>

      <div class="field">
        <label for="failover-reason" class="field__label">Reason</label>
        <textarea
          id="failover-reason"
          v-model="reason"
          v-bind="reasonAttrs"
          rows="3"
          maxlength="500"
          :aria-invalid="Boolean(errors.reason)"
          :aria-describedby="errors.reason ? 'failover-reason-error' : undefined"
        />
        <p v-if="errors.reason" id="failover-reason-error" class="field__error" role="alert">
          {{ errors.reason }}
        </p>
      </div>

      <div v-if="mode === 'forced'" class="field">
        <label for="failover-confirmation" class="field__label">Type FORCE to confirm</label>
        <input
          id="failover-confirmation"
          v-model="confirmation"
          v-bind="confirmationAttrs"
          autocomplete="off"
          :aria-invalid="Boolean(errors.confirmation)"
          :aria-describedby="errors.confirmation ? 'failover-confirmation-error' : undefined"
        />
        <p v-if="errors.confirmation" id="failover-confirmation-error" class="field__error" role="alert">
          {{ errors.confirmation }}
        </p>
      </div>

      <p v-if="serverError" class="form__server-error" role="alert">The sentry refused: {{ serverError }}</p>

      <div class="form__actions">
        <BaseButton @click="emit('close')">Cancel</BaseButton>
        <!-- Never disabled for invalid input: submitting is how people find out what's missing. -->
        <BaseButton
          type="submit"
          variant="danger"
          :loading="isSubmitting"
          :disabled="!sentry.canTriggerFailover"
        >
          Start failover
        </BaseButton>
      </div>
    </form>
  </BaseModal>
</template>

<style scoped>
.form {
  display: grid;
  gap: var(--space-4);
}

.field {
  display: grid;
  gap: var(--space-2);
  border: none;
  margin: 0;
  padding: 0;
}

.field__label {
  font-weight: 600;
  padding: 0;
}

.field select,
.field textarea,
.field input:not([type='radio']) {
  font: inherit;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
}

.field [aria-invalid='true'] {
  border-color: var(--color-unhealthy);
}

.choice {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-2);
  align-items: start;
}

.field__error,
.form__server-error {
  margin: 0;
  color: var(--color-unhealthy);
  font-weight: 600;
}

.form__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
