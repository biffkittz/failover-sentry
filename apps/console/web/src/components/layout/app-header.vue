<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useNotificationsStore } from '@/stores/notifications';
import { usePreferencesStore } from '@/stores/preferences';
import { useSentryStore } from '@/stores/sentry';

const auth = useAuthStore();
const sentry = useSentryStore();
const preferences = usePreferencesStore();
const notifications = useNotificationsStore();
const router = useRouter();

const themeLabel = computed(
  () => ({ system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' })[preferences.theme],
);

async function logout(): Promise<void> {
  try {
    await auth.logout();
    await router.push({ name: 'login' });
  } catch (error) {
    notifications.error('Sign-out failed', (error as Error).message);
  }
}
</script>

<template>
  <header class="header">
    <RouterLink :to="{ name: 'dashboard' }" class="header__brand">
      <img src="/favicon.svg" alt="" width="28" height="28" />
      <span>Failover Sentry</span>
      <span v-if="sentry.state" class="header__service mono">{{ sentry.state.serviceName }}</span>
    </RouterLink>
    <nav class="header__nav" aria-label="Main">
      <RouterLink :to="{ name: 'dashboard' }" exact-active-class="is-active">Overview</RouterLink>
      <RouterLink :to="{ name: 'failovers' }" active-class="is-active">
        Failovers
        <span v-if="sentry.isFailoverInProgress" class="header__dot" aria-label="(one in progress)">●</span>
      </RouterLink>
      <RouterLink :to="{ name: 'timeline' }" active-class="is-active">
        Timeline
        <span
          v-if="sentry.openCriticalAlerts.length > 0"
          class="header__count"
          :aria-label="`(${sentry.openCriticalAlerts.length} critical alerts)`"
        >
          {{ sentry.openCriticalAlerts.length }}
        </span>
      </RouterLink>
    </nav>
    <div class="header__user">
      <button
        type="button"
        class="header__icon-button"
        :aria-label="themeLabel"
        :title="themeLabel"
        @click="preferences.cycleTheme()"
      >
        <span aria-hidden="true">{{
          preferences.theme === 'dark' ? '☾' : preferences.theme === 'light' ? '☀' : '◐'
        }}</span>
      </button>
      <img
        v-if="auth.user?.avatarUrl"
        :src="auth.user.avatarUrl"
        :alt="`${auth.user.login}'s avatar`"
        class="header__avatar"
        width="28"
        height="28"
      />
      <span class="header__login">{{ auth.user?.login }}</span>
      <button type="button" class="header__logout" @click="logout">Sign out</button>
    </div>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-5);
  padding: var(--space-3) var(--space-5);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}

.header__brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 700;
  color: var(--color-text);
  text-decoration: none;
}

.header__service {
  font-weight: 400;
  color: var(--color-text-muted);
}

.header__nav {
  display: flex;
  gap: var(--space-1);
  flex: 1;
  flex-wrap: wrap;
}

.header__nav a {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  text-decoration: none;
  font-weight: 600;
}

.header__nav a:hover,
.header__nav a.is-active {
  color: var(--color-text);
  background: var(--color-surface-muted);
}

.header__dot {
  color: var(--color-degraded);
}

.header__count {
  display: inline-grid;
  place-items: center;
  min-width: 1.25rem;
  padding: 0 0.3rem;
  border-radius: var(--radius-pill);
  background: var(--color-unhealthy);
  color: var(--color-on-danger);
  font-size: 0.75rem;
}

.header__user {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.header__avatar {
  border-radius: 50%;
}

.header__login {
  font-weight: 600;
}

.header__icon-button,
.header__logout {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  border-radius: var(--radius-sm);
  min-height: 2rem;
  min-width: 2rem;
  padding: 0 var(--space-2);
  cursor: pointer;
  font: inherit;
}
</style>
