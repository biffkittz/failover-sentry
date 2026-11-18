<script setup lang="ts">
/**
 * The signed-in layout: skip link, header, breadcrumbs, the routed page (with a Suspense fallback and an error
 * boundary) and the toast region. It owns the live state stream, so it runs once for the whole session.
 */
import { watch } from 'vue';
import { useRoute } from 'vue-router';
import ErrorBoundary from '@/components/ui/error-boundary.vue';
import ToastRegion from '@/components/ui/toast-region.vue';
import { useSentryStream } from '@/composables/use-sentry-stream';
import AppBreadcrumbs from './app-breadcrumbs.vue';
import AppHeader from './app-header.vue';

useSentryStream();
const route = useRoute();

// On navigation, move focus to the new page's main heading so screen readers announce it.
watch(
  () => route.fullPath,
  () => {
    requestAnimationFrame(() => document.querySelector<HTMLElement>('main h1')?.focus());
  },
);
</script>

<template>
  <a class="skip-link" href="#main">Skip to content</a>
  <AppHeader />
  <div class="shell">
    <AppBreadcrumbs />
    <main id="main" class="shell__main" tabindex="-1">
      <RouterView v-slot="{ Component }">
        <ErrorBoundary :key="route.path" label="This page">
          <Suspense>
            <component :is="Component" />
            <template #fallback>
              <p role="status" class="shell__loading">Loading…</p>
            </template>
          </Suspense>
        </ErrorBoundary>
      </RouterView>
    </main>
  </div>
  <ToastRegion />
</template>

<style scoped>
.skip-link {
  position: absolute;
  left: var(--space-3);
  top: -3rem;
  padding: var(--space-2) var(--space-3);
  background: var(--color-primary);
  color: var(--color-on-primary);
  border-radius: var(--radius-sm);
  z-index: 100;
}

.skip-link:focus {
  top: var(--space-3);
}

.shell {
  max-width: 82rem;
  margin: 0 auto;
  padding: var(--space-4) var(--space-4) var(--space-7);
  display: grid;
  gap: var(--space-4);
}

.shell__main:focus {
  outline: none;
}

.shell__loading {
  color: var(--color-text-muted);
}

@media (min-width: 48rem) {
  .shell {
    padding-inline: var(--space-5);
  }
}
</style>
