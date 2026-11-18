<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BaseButton from '@/components/ui/base-button.vue';
import { vAutofocus } from '@/directives/v-autofocus';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const busy = ref(false);
const failure = ref<string | null>(null);

const ERRORS: Record<string, string> = {
  not_allowed: 'Your GitHub account is not on the list of operators for this console.',
  state: 'The sign-in took too long or was tampered with. Please try again.',
  github: 'GitHub sign-in failed. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  expired: 'Your session expired. Please sign in again.',
  github_disabled: 'GitHub sign-in is not enabled on this server.',
};

const returnTo = computed(() =>
  typeof route.query.returnTo === 'string' && route.query.returnTo.startsWith('/')
    ? route.query.returnTo
    : '/',
);
const message = computed(
  () =>
    failure.value ??
    (typeof route.query.error === 'string' ? (ERRORS[route.query.error] ?? 'Sign-in failed.') : null),
);
const githubHref = computed(() => `/auth/github/login?returnTo=${encodeURIComponent(returnTo.value)}`);

onMounted(() => {
  void auth.detectAuthMode().catch(() => undefined);
});

async function devLogin(): Promise<void> {
  busy.value = true;
  failure.value = null;
  try {
    await auth.devLogin();
    await router.replace(returnTo.value);
  } catch (error) {
    failure.value = (error as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login">
    <section class="login__card" aria-labelledby="login-title">
      <img src="/favicon.svg" alt="" width="48" height="48" />
      <h1 id="login-title" tabindex="-1">Failover Sentry</h1>
      <p class="login__lead">Multi-region disaster recovery, orchestrated durably by Temporal.</p>
      <p v-if="message" class="login__error" role="alert">{{ message }}</p>
      <a v-if="auth.authMode === 'github'" v-autofocus class="login__github" :href="githubHref"
        >Sign in with GitHub</a
      >
      <BaseButton v-else variant="primary" :loading="busy" @click="devLogin"
        >Sign in as the local operator</BaseButton
      >
      <p class="login__note">
        Only allowlisted operators can sign in. The console keeps your session in a secure, HTTP-only cookie.
      </p>
    </section>
  </main>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--space-4);
}

.login__card {
  width: min(28rem, 100%);
  display: grid;
  justify-items: center;
  gap: var(--space-3);
  text-align: center;
  padding: var(--space-6) var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.login__card h1 {
  margin: 0;
}

.login__lead,
.login__note {
  color: var(--color-text-muted);
  margin: 0;
}

.login__note {
  font-size: 0.85rem;
}

.login__error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-unhealthy-bg);
  color: var(--color-unhealthy);
  font-weight: 600;
}

.login__github {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.75rem;
  padding: 0 var(--space-5);
  border-radius: var(--radius-sm);
  background: var(--color-text);
  color: var(--color-bg);
  font-weight: 700;
  text-decoration: none;
}

.login__github:hover {
  color: var(--color-bg);
  opacity: 0.9;
}
</style>
