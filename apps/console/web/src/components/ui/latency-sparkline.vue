<script setup lang="ts">
/**
 * Latency of the latest probes as an SVG sparkline; failed probes are red ticks on the baseline. The SVG has a text
 * alternative for screen readers.
 */
import type { ProbeResult } from '@failover-sentry/contracts';
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{ probes: ProbeResult[]; width?: number; height?: number; label?: string }>(),
  {
    width: 240,
    height: 48,
    label: 'Probe latency',
  },
);

const points = computed(() => {
  const probes = props.probes.slice(-40);
  const max = Math.max(100, ...probes.filter((probe) => probe.ok).map((probe) => probe.latencyMs));
  const step = probes.length > 1 ? props.width / (probes.length - 1) : props.width;
  return probes.map((probe, index) => ({
    x: Math.round(index * step * 10) / 10,
    y: probe.ok
      ? Math.round((props.height - 4 - (probe.latencyMs / max) * (props.height - 8)) * 10) / 10
      : props.height - 2,
    ok: probe.ok,
    key: `${probe.at}-${index}`,
  }));
});

const path = computed(() =>
  points.value
    .filter((point) => point.ok)
    .map((point) => `${point.x},${point.y}`)
    .join(' '),
);

const summary = computed(() => {
  const ok = props.probes.filter((probe) => probe.ok);
  const failed = props.probes.length - ok.length;
  const last = props.probes[props.probes.length - 1];
  const lastText = last ? (last.ok ? `last ${last.latencyMs} ms` : 'last probe failed') : 'no probes yet';
  return `${props.label}: ${props.probes.length} probes, ${failed} failed, ${lastText}.`;
});
</script>

<template>
  <svg
    class="sparkline"
    :viewBox="`0 0 ${width} ${height}`"
    :width="width"
    :height="height"
    role="img"
    :aria-label="summary"
  >
    <title>{{ summary }}</title>
    <polyline v-if="path" class="sparkline__line" :points="path" fill="none" />
    <template v-for="point in points" :key="point.key">
      <line
        v-if="!point.ok"
        class="sparkline__failure"
        :x1="point.x"
        :x2="point.x"
        :y1="height"
        :y2="height - 10"
      />
    </template>
  </svg>
</template>

<style scoped>
.sparkline {
  display: block;
  max-width: 100%;
  height: auto;
}

.sparkline__line {
  stroke: var(--color-primary);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.sparkline__failure {
  stroke: var(--color-unhealthy);
  stroke-width: 2;
}
</style>
