<script setup lang="ts">
defineProps<{ title: string; message?: string }>();
</script>

<template>
  <div class="empty" role="status">
    <p class="empty__title">{{ title }}</p>
    <p v-if="message" class="empty__message">{{ message }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty {
  text-align: center;
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-muted);
}

.empty__title {
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 var(--space-2);
}

.empty__message {
  margin: 0 0 var(--space-3);
}
</style>
