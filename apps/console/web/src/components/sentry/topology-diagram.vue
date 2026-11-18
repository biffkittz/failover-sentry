<script setup lang="ts">
/**
 * Where traffic flows right now: edge → active region, with each region's database role. Purely presentational; a
 * text summary describes the same picture for screen readers.
 */
import type { EdgeRouting, FailoverRun, RegionView } from '@failover-sentry/contracts';
import { computed } from 'vue';

const props = defineProps<{
  edge: EdgeRouting | null;
  edgePublicUrl: string;
  regions: RegionView[];
  currentFailover: FailoverRun | null;
}>();

const host = computed(() => {
  try {
    return new URL(props.edgePublicUrl).host;
  } catch {
    return props.edgePublicUrl;
  }
});

const routedTo = computed(() => (props.edge?.mode === 'active' ? props.edge.activeRegionId : null));

const summary = computed(() => {
  if (!props.edge) {
    return `The edge at ${host.value} has no routing yet.`;
  }
  if (props.edge.mode === 'maintenance') {
    return `The edge at ${host.value} serves the maintenance page (epoch ${props.edge.epoch}).`;
  }
  return `The edge at ${host.value} routes traffic to ${routedTo.value} at epoch ${props.edge.epoch}.`;
});

function dbLabel(region: RegionView): string {
  const db = region.health?.lastProbe?.db;
  if (!db) {
    return 'database unknown';
  }
  return `${db.role} · epoch ${db.epoch}`;
}
</script>

<template>
  <figure class="topology">
    <figcaption class="visually-hidden">{{ summary }}</figcaption>
    <div
      class="topology__edge"
      :class="{ 'topology__edge--maintenance': edge?.mode === 'maintenance' }"
      aria-hidden="true"
    >
      <span class="topology__label">Cloudflare edge</span>
      <strong class="mono">{{ host }}</strong>
      <span class="topology__meta">{{ edge ? `${edge.mode} · epoch ${edge.epoch}` : 'no routing' }}</span>
    </div>
    <div class="topology__links" aria-hidden="true">
      <div
        v-for="region in regions"
        :key="region.config.id"
        class="topology__link"
        :class="{
          'topology__link--active': region.config.id === routedTo,
          'topology__link--target': currentFailover?.toRegionId === region.config.id,
        }"
      />
    </div>
    <div class="topology__regions" aria-hidden="true">
      <div
        v-for="region in regions"
        :key="region.config.id"
        class="topology__region"
        :class="{ 'topology__region--active': region.config.id === routedTo }"
      >
        <strong>{{ region.config.displayName }}</strong>
        <span class="topology__meta">{{ region.role === 'PRIMARY' ? 'Primary' : 'Standby' }}</span>
        <span class="topology__db mono">{{ dbLabel(region) }}</span>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.topology {
  margin: 0;
  display: grid;
  gap: 0;
  justify-items: center;
}

.topology__edge,
.topology__region {
  display: grid;
  gap: 0.125rem;
  justify-items: center;
  text-align: center;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-surface-muted);
  min-width: 12rem;
}

.topology__edge--maintenance {
  border-color: var(--color-degraded);
  background: var(--color-degraded-bg);
}

.topology__label,
.topology__meta {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.topology__links {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  width: 100%;
  height: 2rem;
}

.topology__link {
  justify-self: center;
  width: 2px;
  background: var(--color-border);
}

.topology__link--active {
  width: 4px;
  background: var(--color-healthy);
}

.topology__link--target:not(.topology__link--active) {
  background: repeating-linear-gradient(to bottom, var(--color-degraded) 0 6px, transparent 6px 10px);
  width: 3px;
}

.topology__regions {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: var(--space-3);
  width: 100%;
}

.topology__region {
  min-width: 0;
}

.topology__region--active {
  border-color: var(--color-healthy);
  background: var(--color-healthy-bg);
}

.topology__db {
  font-size: 0.8rem;
}
</style>
