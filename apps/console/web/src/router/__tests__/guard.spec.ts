import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { ApiError } from '@/api/http';
import { authApi } from '@/api/sentry-api';
import { createAppRouter } from '@/router';

describe('router guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('sends anonymous visitors to the sign-in page and remembers where they were going', async () => {
    vi.spyOn(authApi, 'me').mockRejectedValue(new ApiError(401, 'unauthenticated', 'Sign in'));
    const router = createAppRouter(createMemoryHistory());
    await router.push('/failovers/fo-3');
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.returnTo).toBe('/failovers/fo-3');
  });

  it('lets signed-in operators through and builds breadcrumb metadata', async () => {
    vi.spyOn(authApi, 'me').mockResolvedValue({
      login: 'octocat',
      name: null,
      avatarUrl: null,
      authMode: 'github',
    });
    const router = createAppRouter(createMemoryHistory());
    await router.push('/failovers/fo-3');
    const route = router.currentRoute.value;
    expect(route.name).toBe('failover');
    const crumbs = route.matched
      .map((record) => record.meta.breadcrumb)
      .filter(Boolean)
      .map((crumb) => (typeof crumb === 'function' ? crumb(route) : crumb));
    expect(crumbs).toEqual(['Overview', 'Failovers', 'fo-3']);
  });
});
