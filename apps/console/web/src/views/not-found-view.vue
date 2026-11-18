<script setup lang="ts">
import EmptyState from '@/components/ui/empty-state.vue';
</script>

<template>
  <main class="not-found">
    <h1 tabindex="-1">Page not found</h1>
    <EmptyState title="Nothing lives at this address." message="Check the link, or go back to the overview.">
      <RouterLink to="/">Back to the overview</RouterLink>
    </EmptyState>
  </main>
</template>

<style scoped>
.not-found {
  max-width: 40rem;
  margin: var(--space-7) auto;
  padding: var(--space-4);
  text-align: center;
}
</style>
