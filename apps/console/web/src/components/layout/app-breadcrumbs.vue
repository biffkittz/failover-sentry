<script setup lang="ts">
/** Breadcrumbs from the matched routes' `meta.breadcrumb` (a label, or a function of the route). */
import { computed } from 'vue';
import { useRoute, type RouteLocationRaw } from 'vue-router';

const route = useRoute();

const crumbs = computed(() =>
  route.matched
    .filter((record) => record.meta.breadcrumb)
    .map((record, index, all) => {
      const meta = record.meta.breadcrumb;
      const label = typeof meta === 'function' ? meta(route) : (meta ?? '');
      const to: RouteLocationRaw = record.name
        ? { name: record.name, params: route.params }
        : { path: record.path || '/' };
      return { key: `${record.path}-${index}`, label, to, current: index === all.length - 1 };
    }),
);
</script>

<template>
  <nav v-if="crumbs.length > 1" class="breadcrumbs" aria-label="Breadcrumb">
    <ol>
      <li v-for="crumb in crumbs" :key="crumb.key">
        <RouterLink v-if="!crumb.current" :to="crumb.to">{{ crumb.label }}</RouterLink>
        <span v-else aria-current="page">{{ crumb.label }}</span>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.breadcrumbs ol {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  font-size: 0.9rem;
}

.breadcrumbs li + li::before {
  content: '›';
  margin-right: var(--space-2);
  color: var(--color-text-muted);
}

.breadcrumbs [aria-current='page'] {
  color: var(--color-text-muted);
}
</style>
