/**
 * Routes. The signed-in pages nest under the app shell; every page is its own chunk (code splitting). A global
 * guard sends anonymous visitors to the sign-in page and remembers where they were going.
 */
import {
  createRouter,
  createWebHistory,
  type RouteLocationNormalizedLoaded,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without signing in. */
    public?: boolean;
    /** Document title (suffixed with the app name). */
    title?: string;
    /** Breadcrumb label: text, or computed from the route. */
    breadcrumb?: string | ((route: RouteLocationNormalizedLoaded) => string);
  }
}

export const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/login-view.vue'),
    meta: { public: true, title: 'Sign in' },
  },
  {
    path: '/',
    component: () => import('@/components/layout/app-shell.vue'),
    meta: { breadcrumb: 'Overview' },
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('@/views/dashboard-view.vue'),
        meta: { title: 'Overview' },
      },
      {
        path: 'failovers',
        component: () => import('@/views/failovers-view.vue'),
        meta: { breadcrumb: 'Failovers' },
        children: [
          {
            path: '',
            name: 'failovers',
            component: () => import('@/views/failover-list-view.vue'),
            meta: { title: 'Failovers' },
          },
          {
            path: ':failoverId',
            name: 'failover',
            component: () => import('@/views/failover-detail-view.vue'),
            props: true,
            meta: { title: 'Failover', breadcrumb: (route) => String(route.params.failoverId ?? '') },
          },
        ],
      },
      {
        path: 'regions/:regionId',
        name: 'region',
        component: () => import('@/views/region-detail-view.vue'),
        props: true,
        meta: { title: 'Region', breadcrumb: (route) => `Region ${String(route.params.regionId ?? '')}` },
      },
      {
        path: 'timeline',
        name: 'timeline',
        component: () => import('@/views/timeline-view.vue'),
        meta: { title: 'Timeline', breadcrumb: 'Timeline' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/not-found-view.vue'),
    meta: { public: true, title: 'Not found' },
  },
];

export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  const router = createRouter({
    history,
    routes,
    scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
  });

  router.beforeEach(async (to) => {
    if (to.meta.public) {
      return true;
    }
    const auth = useAuthStore();
    if (auth.status === 'unknown') {
      await auth.fetchMe().catch(() => undefined);
    }
    if (!auth.isAuthenticated) {
      return { name: 'login', query: { returnTo: to.fullPath } };
    }
    return true;
  });

  router.afterEach((to) => {
    document.title = to.meta.title ? `${to.meta.title} · Failover Sentry` : 'Failover Sentry';
  });

  return router;
}
