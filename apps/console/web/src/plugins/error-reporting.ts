/**
 * Global error handling: uncaught errors from components, router navigations and promises are shown to the user
 * as a toast and reported to the console server, which logs them where Log Analytics collects them.
 */
import { CSRF_HEADER } from '@failover-sentry/contracts';
import type { App } from 'vue';
import type { Router } from 'vue-router';
import { ApiError } from '@/api/http';
import { useNotificationsStore } from '@/stores/notifications';

let lastReport = 0;

export function reportError(error: unknown, source: string, route?: string): void {
  // At most one report per second: an error in a render loop must not flood the server.
  const now = Date.now();
  if (now - lastReport < 1_000) {
    return;
  }
  lastReport = now;
  const err = error instanceof Error ? error : new Error(String(error));
  void fetch('/api/client-errors', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: JSON.stringify({
      message: err.message.slice(0, 2_000),
      source: source.slice(0, 200),
      ...(route ? { route: route.slice(0, 500) } : {}),
      ...(err.stack ? { stack: err.stack.slice(0, 4_000) } : {}),
    }),
    keepalive: true,
  }).catch(() => undefined);
}

export function installErrorReporting(app: App, router: Router): void {
  app.config.errorHandler = (error, _instance, info) => {
    console.error(error);
    if (!(error instanceof ApiError)) {
      reportError(error, `vue:${info}`, router.currentRoute.value.fullPath);
    }
    useNotificationsStore().error(
      'Something went wrong',
      error instanceof Error ? error.message : String(error),
    );
  };
  router.onError((error) => {
    reportError(error, 'router', router.currentRoute.value.fullPath);
    useNotificationsStore().error('Navigation failed', (error as Error).message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    if (event.reason instanceof ApiError || (event.reason as Error)?.name === 'AbortError') {
      return;
    }
    reportError(event.reason, 'unhandledrejection', router.currentRoute.value.fullPath);
  });
}
