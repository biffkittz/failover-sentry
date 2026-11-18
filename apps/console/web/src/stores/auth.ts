/** Who is signed in. The session itself is an HTTP-only cookie the app never sees; this store asks the server. */
import type { ConsoleUser } from '@failover-sentry/contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError } from '@/api/http';
import { authApi, type AuthMode } from '@/api/sentry-api';

export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous';

export const useAuthStore = defineStore('auth', () => {
  // State
  const user = ref<ConsoleUser | null>(null);
  const status = ref<AuthStatus>('unknown');
  const authMode = ref<AuthMode>('github');

  // Getters
  const isAuthenticated = computed(() => status.value === 'authenticated');
  const displayName = computed(() => user.value?.name ?? user.value?.login ?? '');

  // Actions
  async function fetchMe(): Promise<AuthStatus> {
    try {
      const me = await authApi.me();
      user.value = { login: me.login, name: me.name, avatarUrl: me.avatarUrl };
      authMode.value = me.authMode;
      status.value = 'authenticated';
    } catch (error) {
      if (!(error instanceof ApiError) || !error.isUnauthenticated) {
        throw error;
      }
      user.value = null;
      status.value = 'anonymous';
    }
    return status.value;
  }

  /** The 401 answer of /api/me says which sign-in the server offers. */
  async function detectAuthMode(): Promise<void> {
    const response = await fetch('/api/me', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (response.status === 401) {
      const body = (await response.json().catch(() => null)) as { authMode?: AuthMode } | null;
      if (body?.authMode) {
        authMode.value = body.authMode;
      }
    }
  }

  async function devLogin(): Promise<void> {
    await authApi.devLogin();
    await fetchMe();
  }

  async function logout(): Promise<void> {
    await authApi.logout();
    user.value = null;
    status.value = 'anonymous';
  }

  return { user, status, authMode, isAuthenticated, displayName, fetchMe, detectAuthMode, devLogin, logout };
});
