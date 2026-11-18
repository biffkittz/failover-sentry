<script setup lang="ts">
/** A titled surface. Pass `headingLevel` to keep the document outline correct wherever it is used. */
withDefaults(defineProps<{ title?: string; headingLevel?: 2 | 3 | 4; highlighted?: boolean }>(), {
  headingLevel: 2,
  highlighted: false,
});
</script>

<template>
  <section class="card" :class="{ 'card--highlighted': highlighted }">
    <header v-if="title || $slots.actions" class="card__header">
      <component :is="`h${headingLevel}`" v-if="title" class="card__title">{{ title }}</component>
      <div v-if="$slots.actions" class="card__actions"><slot name="actions" /></div>
    </header>
    <div class="card__body"><slot /></div>
    <footer v-if="$slots.footer" class="card__footer"><slot name="footer" /></footer>
  </section>
</template>

<style scoped>
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.card--highlighted {
  border-color: var(--color-primary);
  box-shadow:
    0 0 0 1px var(--color-primary),
    var(--shadow-sm);
}

.card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) 0;
  flex-wrap: wrap;
}

.card__title {
  font-size: 1.05rem;
  margin: 0;
}

.card__actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.card__body {
  padding: var(--space-4);
  flex: 1;
}

.card__footer {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border);
}
</style>
