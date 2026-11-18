/**
 * Per-browser preferences (theme, timeline filter). Persisted by the `persist` store plugin; nothing sensitive is
 * kept here (the session never leaves its HTTP-only cookie).
 */
import type { AlertSeverity } from '@failover-sentry/contracts';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export type ThemePreference = 'system' | 'light' | 'dark';

export const usePreferencesStore = defineStore(
  'preferences',
  () => {
    const theme = ref<ThemePreference>('system');
    const timelineMinimumSeverity = ref<AlertSeverity>('info');

    function applyTheme(value: ThemePreference): void {
      const root = document.documentElement;
      if (value === 'system') {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', value);
      }
    }

    watch(theme, applyTheme, { immediate: true });

    function cycleTheme(): void {
      theme.value = theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system';
    }

    return { theme, timelineMinimumSeverity, cycleTheme };
  },
  { persist: { key: 'failover-sentry:preferences', pick: ['theme', 'timelineMinimumSeverity'] } },
);
