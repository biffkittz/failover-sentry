<script setup lang="ts">
/**
 * A status pill. The tone is never the only signal: every badge has a text label and a distinct shape, so it reads
 * without colour too.
 */
import type { BadgeTone } from './types';

defineProps<{ tone: BadgeTone; label: string }>();

const SHAPES: Record<BadgeTone, string> = {
  healthy: '●',
  degraded: '▲',
  unhealthy: '■',
  unknown: '○',
  info: '◆',
};
</script>

<template>
  <span class="badge" :class="`badge--${tone}`">
    <span class="badge__shape" aria-hidden="true">{{ SHAPES[tone] }}</span>
    <span class="badge__label">{{ label }}</span>
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0.125rem var(--space-2);
  border-radius: var(--radius-pill);
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
}

.badge__shape {
  font-size: 0.7em;
}

.badge--healthy {
  background: var(--color-healthy-bg);
  color: var(--color-healthy);
}

.badge--degraded {
  background: var(--color-degraded-bg);
  color: var(--color-degraded);
}

.badge--unhealthy {
  background: var(--color-unhealthy-bg);
  color: var(--color-unhealthy);
}

.badge--unknown {
  background: var(--color-unknown-bg);
  color: var(--color-unknown);
}

.badge--info {
  background: var(--color-info-bg);
  color: var(--color-info);
}
</style>
