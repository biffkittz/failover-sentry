<script setup lang="ts">
/**
 * An accessible modal dialog: rendered at the end of <body> (Teleport), labelled by its title, traps focus while
 * open, closes on Escape or a backdrop click, and returns focus to whatever opened it.
 */
import { computed, toRef, useId, useTemplateRef } from 'vue';
import { useFocusTrap } from '@/composables/use-focus-trap';

const props = withDefaults(
  defineProps<{ open: boolean; title: string; description?: string; dismissible?: boolean }>(),
  {
    dismissible: true,
  },
);
const emit = defineEmits<{ close: [] }>();

const panel = useTemplateRef<HTMLElement>('panel');
const titleId = useId();
const descriptionId = useId();
useFocusTrap(panel, toRef(props, 'open'));

const describedBy = computed(() => (props.description ? descriptionId : undefined));

function requestClose(): void {
  if (props.dismissible) {
    emit('close');
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal" @keydown.esc.stop="requestClose">
      <div class="modal__backdrop" aria-hidden="true" @click="requestClose" />
      <div
        ref="panel"
        class="modal__panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="describedBy"
        tabindex="-1"
      >
        <header class="modal__header">
          <h2 :id="titleId" class="modal__title">{{ title }}</h2>
          <button
            v-if="dismissible"
            type="button"
            class="modal__close"
            aria-label="Close dialog"
            @click="requestClose"
          >
            ✕
          </button>
        </header>
        <p v-if="description" :id="descriptionId" class="modal__description">{{ description }}</p>
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: var(--space-4);
  z-index: 50;
}

.modal__backdrop {
  position: absolute;
  inset: 0;
  background: rgb(8 12 20 / 55%);
}

.modal__panel {
  position: relative;
  width: min(36rem, 100%);
  max-height: calc(100vh - 2 * var(--space-4));
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-5);
}

.modal__panel:focus {
  outline: none;
}

.modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.modal__title {
  font-size: 1.25rem;
}

.modal__close {
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 1.1rem;
  cursor: pointer;
  border-radius: var(--radius-sm);
  min-width: 2rem;
  min-height: 2rem;
}

.modal__close:hover {
  background: var(--color-surface-muted);
}

.modal__description {
  color: var(--color-text-muted);
  margin-top: 0;
}
</style>
